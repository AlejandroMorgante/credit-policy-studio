from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol

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


class ObjectStore(Protocol):
    """The four primitives a versioned object store must provide.

    Both Cloud Storage and S3 offer create-only and replace-if-unchanged writes;
    everything the policy repository does is expressed in terms of them, so the
    repository logic lives in exactly one place.
    """

    def read(self, key: str, version: str | int | None = None) -> str: ...

    def create(self, key: str, payload: str) -> str | int: ...

    def replace(self, key: str, payload: str) -> str | int: ...

    def put(self, key: str, payload: str) -> str | int: ...

    def version_of(self, key: str) -> str | int: ...

    def list_direct(self, prefix: str) -> list[str]:
        """Direct children of prefix: object keys, plus child prefixes ending in "/"."""
        ...


class ObjectPolicyRepository:
    """Immutable policy objects selected by a small mutable active pointer.

    Cloud-agnostic: the only cloud-specific code is the ObjectStore it is given.
    """

    def __init__(self, store: ObjectStore, active_object: str) -> None:
        self.store = store
        self.active_object = active_object

    @staticmethod
    def _sha(policy: CreditPolicy) -> str:
        payload = json.dumps(
            policy.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        ).encode()
        return sha256(payload).hexdigest()

    @staticmethod
    def _object_name(policy_id: str, version: str) -> str:
        return f"policies/{policy_id}/{version}.json"

    @staticmethod
    def _revision_name(policy_id: str, version: str, digest: str) -> str:
        return f"policies/{policy_id}/{version}/revisions/{digest}.json"

    def _pointer(self) -> dict[str, Any] | None:
        try:
            return json.loads(self.store.read(self.active_object))
        except FileNotFoundError:
            return None

    @staticmethod
    def _pointer_version(pointer: dict[str, Any]) -> str | int | None:
        # "generation" is the legacy Cloud Storage key still written by
        # scripts/publish_policy.sh; new pointers carry "version_id".
        return pointer.get("version_id") or pointer.get("generation")

    def _policy_id(self) -> str:
        """From the active pointer, or the only published prefix when none exists yet.

        Publishing the very first version has to work before any pointer is written.
        """
        pointer = self._pointer()
        if pointer and pointer.get("policy_id"):
            return str(pointer["policy_id"])
        # Only child prefixes are candidate policy ids; policies/active.json is not one.
        prefixes = {
            key.removeprefix("policies/").rstrip("/")
            for key in self.store.list_direct("policies/")
            if key.endswith("/")
        }
        if len(prefixes) != 1:
            raise FileNotFoundError(
                "No policy has been published yet"
                if not prefixes
                else "Several policy ids exist; activate one to set the active pointer"
            )
        return prefixes.pop()

    def get_active(self) -> CreditPolicy:
        pointer = self._pointer()
        if pointer is None:
            raise FileNotFoundError("No active policy pointer exists")
        payload = self.store.read(pointer["object"], self._pointer_version(pointer))
        policy = CreditPolicy.model_validate_json(payload)
        if policy.metadata.version != pointer["version"]:
            raise ValueError("Active pointer version does not match the referenced policy")
        return policy

    def get_version(self, version: str) -> CreditPolicy:
        object_name = self._object_name(self._policy_id(), version)
        policy = CreditPolicy.model_validate_json(self.store.read(object_name))
        if policy.metadata.version != version:
            raise ValueError("Stored policy version does not match its object name")
        return policy

    def get_revision(self, version: str, policy_sha256: str) -> CreditPolicy:
        current = self.get_version(version)
        if self._sha(current) == policy_sha256:
            return current
        key = self._revision_name(self._policy_id(), version, policy_sha256)
        try:
            return CreditPolicy.model_validate_json(self.store.read(key))
        except FileNotFoundError as error:
            raise FileNotFoundError(
                f"Revision {policy_sha256!r} for policy version {version!r} does not exist"
            ) from error

    def list_versions(self) -> list[dict[str, str | bool]]:
        pointer = self._pointer()
        active_version = pointer["version"] if pointer else None
        prefix = f"policies/{self._policy_id()}/"
        versions: list[dict[str, str | bool]] = []
        for key in self.store.list_direct(prefix):
            if not key.endswith(".json"):
                continue
            policy = CreditPolicy.model_validate_json(self.store.read(key))
            versions.append(
                {
                    "version": policy.metadata.version,
                    "created_at": policy.metadata.created_at.isoformat(),
                    "created_by": policy.metadata.created_by,
                    "active": policy.metadata.version == active_version,
                }
            )
        return sorted(versions, key=lambda item: str(item["created_at"]), reverse=True)

    def _write_snapshot(self, policy: CreditPolicy) -> None:
        key = self._revision_name(
            policy.metadata.policy_id, policy.metadata.version, self._sha(policy)
        )
        try:
            self.store.create(key, policy.model_dump_json(indent=2))
        except FileExistsError:
            pass  # An identical revision is already stored; nothing to do.

    def publish(self, policy: CreditPolicy) -> dict[str, str | int]:
        object_name = self._object_name(policy.metadata.policy_id, policy.metadata.version)
        try:
            version_id = self.store.create(object_name, policy.model_dump_json(indent=2))
        except FileExistsError as error:
            raise FileExistsError(
                f"Policy version {policy.metadata.version!r} already exists"
            ) from error
        self._write_snapshot(policy)
        return {
            "policy_id": policy.metadata.policy_id,
            "version": policy.metadata.version,
            "object": object_name,
            "generation": version_id,
        }

    def update(self, policy: CreditPolicy) -> dict[str, str | int]:
        pointer = self._pointer()
        if pointer and policy.metadata.version == pointer["version"]:
            raise PermissionError("The productive version is immutable; create a candidate version")
        object_name = self._object_name(policy.metadata.policy_id, policy.metadata.version)
        try:
            version_id = self.store.replace(object_name, policy.model_dump_json(indent=2))
        except FileNotFoundError as error:
            raise FileNotFoundError(
                f"Policy version {policy.metadata.version!r} does not exist"
            ) from error
        self._write_snapshot(policy)
        return {
            "policy_id": policy.metadata.policy_id,
            "version": policy.metadata.version,
            "object": object_name,
            "generation": version_id,
        }

    def activate(self, version: str) -> dict[str, str | int]:
        policy = self.get_version(version)
        object_name = self._object_name(policy.metadata.policy_id, version)
        pointer = {
            "policy_id": policy.metadata.policy_id,
            "version": version,
            "object": object_name,
            "version_id": self.store.version_of(object_name),
        }
        self.store.put(self.active_object, json.dumps(pointer, separators=(",", ":")))
        return pointer


class GcsObjectStore:
    """Cloud Storage object store; generations are the version tokens."""

    def __init__(self, project_id: str, bucket_name: str, client: Any | None = None) -> None:
        # Imported here so the AWS path never loads the Google Cloud SDK.
        from google.api_core import exceptions
        from google.cloud import storage

        self.exceptions = exceptions
        self.client = client or storage.Client(project=project_id)
        self.bucket_name = bucket_name

    def _bucket(self) -> Any:
        return self.client.bucket(self.bucket_name)

    def read(self, key: str, version: str | int | None = None) -> str:
        try:
            return self._bucket().blob(key, generation=version).download_as_text()
        except self.exceptions.NotFound as error:
            raise FileNotFoundError(f"Object {key!r} does not exist") from error

    def create(self, key: str, payload: str) -> str | int:
        blob = self._bucket().blob(key)
        try:
            blob.upload_from_string(payload, content_type="application/json", if_generation_match=0)
        except self.exceptions.PreconditionFailed as error:
            raise FileExistsError(f"Object {key!r} already exists") from error
        return blob.generation

    def replace(self, key: str, payload: str) -> str | int:
        blob = self._bucket().blob(key)
        try:
            blob.reload()
        except self.exceptions.NotFound as error:
            raise FileNotFoundError(f"Object {key!r} does not exist") from error
        blob.upload_from_string(
            payload, content_type="application/json", if_generation_match=blob.generation
        )
        return blob.generation

    def put(self, key: str, payload: str) -> str | int:
        blob = self._bucket().blob(key)
        blob.upload_from_string(payload, content_type="application/json")
        return blob.generation

    def version_of(self, key: str) -> str | int:
        blob = self._bucket().blob(key)
        try:
            blob.reload()
        except self.exceptions.NotFound as error:
            raise FileNotFoundError(f"Object {key!r} does not exist") from error
        return blob.generation

    def list_direct(self, prefix: str) -> list[str]:
        # Delimiter splits direct blobs from child prefixes; the iterator must be
        # consumed before .prefixes is populated.
        blobs = self.client.list_blobs(self.bucket_name, prefix=prefix, delimiter="/")
        keys = [blob.name for blob in blobs]
        return keys + sorted(blobs.prefixes)


class GcsPolicyRepository(ObjectPolicyRepository):
    def __init__(
        self,
        project_id: str,
        bucket_name: str,
        active_object: str,
        client: Any | None = None,
    ) -> None:
        super().__init__(GcsObjectStore(project_id, bucket_name, client), active_object)
