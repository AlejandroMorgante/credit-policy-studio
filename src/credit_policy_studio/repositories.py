from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from typing import Protocol

from google.cloud import storage

from .models import CreditPolicy


class PolicyRepository(Protocol):
    def get_active(self) -> CreditPolicy: ...

    def get_version(self, version: str) -> CreditPolicy: ...

    def get_revision(self, version: str, policy_sha256: str) -> CreditPolicy: ...

    def list_versions(self) -> list[dict[str, str | bool]]: ...

    def publish(self, policy: CreditPolicy) -> dict[str, str | int]: ...

    def update(self, policy: CreditPolicy) -> dict[str, str | int]: ...

    def activate(self, version: str) -> dict[str, str | int]: ...


class LocalPolicyRepository:
    def __init__(self, path: Path) -> None:
        self.seed_path = path
        self.path = path
        self.pointer_path = Path(".local/active.json")
        if self.pointer_path.exists():
            pointer = json.loads(self.pointer_path.read_text(encoding="utf-8"))
            selected = Path(pointer["path"])
            if selected.exists():
                self.path = selected

    def get_active(self) -> CreditPolicy:
        return CreditPolicy.model_validate_json(self.path.read_text(encoding="utf-8"))

    def _policies(self) -> list[tuple[Path, CreditPolicy]]:
        paths = [self.seed_path, self.path, *Path(".local/policies").glob("*.json")]
        policies: dict[str, tuple[Path, CreditPolicy]] = {}
        for path in paths:
            if not path.exists():
                continue
            policy = CreditPolicy.model_validate_json(path.read_text(encoding="utf-8"))
            policies[policy.metadata.version] = (path, policy)
        return list(policies.values())

    def get_version(self, version: str) -> CreditPolicy:
        for _, policy in self._policies():
            if policy.metadata.version == version:
                return policy
        raise FileNotFoundError(f"Policy version {version!r} does not exist")

    @staticmethod
    def _sha(policy: CreditPolicy) -> str:
        payload = json.dumps(
            policy.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        ).encode()
        return sha256(payload).hexdigest()

    def _write_snapshot(self, policy: CreditPolicy) -> None:
        digest = self._sha(policy)
        snapshot = Path(".local/policies/.revisions") / policy.metadata.version / f"{digest}.json"
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        if not snapshot.exists():
            snapshot.write_text(policy.model_dump_json(indent=2), encoding="utf-8")

    def get_revision(self, version: str, policy_sha256: str) -> CreditPolicy:
        current = self.get_version(version)
        if self._sha(current) == policy_sha256:
            return current
        snapshot = Path(".local/policies/.revisions") / version / f"{policy_sha256}.json"
        if not snapshot.exists():
            raise FileNotFoundError(
                f"Revision {policy_sha256!r} for policy version {version!r} does not exist"
            )
        return CreditPolicy.model_validate_json(snapshot.read_text(encoding="utf-8"))

    def list_versions(self) -> list[dict[str, str | bool]]:
        active = self.get_active().metadata.version
        return sorted(
            [
                {
                    "version": policy.metadata.version,
                    "created_at": policy.metadata.created_at.isoformat(),
                    "created_by": policy.metadata.created_by,
                    "active": policy.metadata.version == active,
                }
                for _, policy in self._policies()
            ],
            key=lambda item: str(item["created_at"]),
            reverse=True,
        )

    def publish(self, policy: CreditPolicy) -> dict[str, str | int]:
        if any(
            existing.metadata.version == policy.metadata.version for _, existing in self._policies()
        ):
            raise FileExistsError(f"Policy version {policy.metadata.version!r} already exists")
        target = Path(".local/policies") / f"{policy.metadata.version}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(policy.model_dump_json(indent=2), encoding="utf-8")
        self._write_snapshot(policy)
        return {"version": policy.metadata.version, "object": str(target), "generation": 1}

    def update(self, policy: CreditPolicy) -> dict[str, str | int]:
        if policy.metadata.version == self.get_active().metadata.version:
            raise PermissionError("The productive version is immutable; create a candidate version")
        for path, existing in self._policies():
            if existing.metadata.version == policy.metadata.version:
                path.write_text(policy.model_dump_json(indent=2), encoding="utf-8")
                self._write_snapshot(policy)
                return {"version": policy.metadata.version, "object": str(path), "generation": 1}
        raise FileNotFoundError(f"Policy version {policy.metadata.version!r} does not exist")

    def activate(self, version: str) -> dict[str, str | int]:
        for path, policy in self._policies():
            if policy.metadata.version == version:
                self.path = path
                self.pointer_path.parent.mkdir(parents=True, exist_ok=True)
                self.pointer_path.write_text(
                    json.dumps({"version": version, "path": str(path)}), encoding="utf-8"
                )
                return {"version": version, "object": str(path), "generation": 1}
        raise FileNotFoundError(f"Policy version {version!r} does not exist")


class GcsPolicyRepository:
    """Loads an immutable policy selected by a small mutable active pointer."""

    def __init__(
        self,
        project_id: str,
        bucket_name: str,
        active_object: str,
        client: storage.Client | None = None,
    ) -> None:
        self.bucket_name = bucket_name
        self.active_object = active_object
        self.client = client or storage.Client(project=project_id)

    def get_active(self) -> CreditPolicy:
        bucket = self.client.bucket(self.bucket_name)
        pointer = json.loads(bucket.blob(self.active_object).download_as_text())
        object_name = pointer["object"]
        generation = pointer.get("generation")
        payload = bucket.blob(object_name, generation=generation).download_as_text()
        policy = CreditPolicy.model_validate_json(payload)
        if policy.metadata.version != pointer["version"]:
            raise ValueError("Active pointer version does not match the referenced policy")
        return policy

    def get_version(self, version: str) -> CreditPolicy:
        active = self.get_active()
        object_name = f"policies/{active.metadata.policy_id}/{version}.json"
        payload = self.client.bucket(self.bucket_name).blob(object_name).download_as_text()
        policy = CreditPolicy.model_validate_json(payload)
        if policy.metadata.version != version:
            raise ValueError("Stored policy version does not match its object name")
        return policy

    @staticmethod
    def _sha(policy: CreditPolicy) -> str:
        payload = json.dumps(
            policy.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        ).encode()
        return sha256(payload).hexdigest()

    def get_revision(self, version: str, policy_sha256: str) -> CreditPolicy:
        current = self.get_version(version)
        if self._sha(current) == policy_sha256:
            return current
        active = self.get_active()
        object_name = (
            f"policies/{active.metadata.policy_id}/{version}/revisions/{policy_sha256}.json"
        )
        payload = self.client.bucket(self.bucket_name).blob(object_name).download_as_text()
        return CreditPolicy.model_validate_json(payload)

    def list_versions(self) -> list[dict[str, str | bool]]:
        active = self.get_active()
        prefix = f"policies/{active.metadata.policy_id}/"
        versions = []
        for blob in self.client.list_blobs(self.bucket_name, prefix=prefix):
            if not blob.name.endswith(".json") or "/" in blob.name.removeprefix(prefix):
                continue
            policy = CreditPolicy.model_validate_json(blob.download_as_text())
            versions.append(
                {
                    "version": policy.metadata.version,
                    "created_at": policy.metadata.created_at.isoformat(),
                    "created_by": policy.metadata.created_by,
                    "active": policy.metadata.version == active.metadata.version,
                }
            )
        return sorted(versions, key=lambda item: str(item["created_at"]), reverse=True)

    def publish(self, policy: CreditPolicy) -> dict[str, str | int]:
        bucket = self.client.bucket(self.bucket_name)
        object_name = f"policies/{policy.metadata.policy_id}/{policy.metadata.version}.json"
        policy_blob = bucket.blob(object_name)
        policy_blob.upload_from_string(
            policy.model_dump_json(indent=2),
            content_type="application/json",
            if_generation_match=0,
        )
        snapshot = bucket.blob(
            f"policies/{policy.metadata.policy_id}/{policy.metadata.version}/revisions/"
            f"{self._sha(policy)}.json"
        )
        snapshot.upload_from_string(
            policy.model_dump_json(indent=2),
            content_type="application/json",
            if_generation_match=0,
        )
        return {
            "policy_id": policy.metadata.policy_id,
            "version": policy.metadata.version,
            "object": object_name,
            "generation": policy_blob.generation,
        }

    def update(self, policy: CreditPolicy) -> dict[str, str | int]:
        if policy.metadata.version == self.get_active().metadata.version:
            raise PermissionError("The productive version is immutable; create a candidate version")
        bucket = self.client.bucket(self.bucket_name)
        object_name = f"policies/{policy.metadata.policy_id}/{policy.metadata.version}.json"
        policy_blob = bucket.blob(object_name)
        policy_blob.reload()
        policy_blob.upload_from_string(
            policy.model_dump_json(indent=2),
            content_type="application/json",
            if_generation_match=policy_blob.generation,
        )
        snapshot = bucket.blob(
            f"policies/{policy.metadata.policy_id}/{policy.metadata.version}/revisions/"
            f"{self._sha(policy)}.json"
        )
        if not snapshot.exists():
            snapshot.upload_from_string(
                policy.model_dump_json(indent=2),
                content_type="application/json",
                if_generation_match=0,
            )
        return {
            "policy_id": policy.metadata.policy_id,
            "version": policy.metadata.version,
            "object": object_name,
            "generation": policy_blob.generation,
        }

    def activate(self, version: str) -> dict[str, str | int]:
        policy = self.get_version(version)
        bucket = self.client.bucket(self.bucket_name)
        object_name = f"policies/{policy.metadata.policy_id}/{version}.json"
        policy_blob = bucket.blob(object_name)
        policy_blob.reload()
        pointer = {
            "policy_id": policy.metadata.policy_id,
            "version": version,
            "object": object_name,
            "generation": policy_blob.generation,
        }
        bucket.blob(self.active_object).upload_from_string(
            json.dumps(pointer, separators=(",", ":")), content_type="application/json"
        )
        return pointer
