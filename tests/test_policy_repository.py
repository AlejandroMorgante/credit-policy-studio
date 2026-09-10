"""Contract tests for the cloud-agnostic policy repository.

ObjectPolicyRepository holds the logic both Cloud Storage and S3 share. Running it
against an in-memory store proves the behaviour is the same on either cloud without
reaching for a cloud mock.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from credit_policy_studio.models import CreditPolicy
from credit_policy_studio.repositories import ObjectPolicyRepository

POLICY_PATH = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"


class MemoryObjectStore:
    """Versioned object store with create-only and replace-if-unchanged writes."""

    def __init__(self) -> None:
        self.versions: dict[str, list[str]] = {}

    def read(self, key: str, version: str | int | None = None) -> str:
        if key not in self.versions:
            raise FileNotFoundError(f"Object {key!r} does not exist")
        if version is None:
            return self.versions[key][-1]
        return self.versions[key][int(version)]

    def create(self, key: str, payload: str) -> str:
        if key in self.versions:
            raise FileExistsError(f"Object {key!r} already exists")
        return self.put(key, payload)

    def replace(self, key: str, payload: str) -> str:
        if key not in self.versions:
            raise FileNotFoundError(f"Object {key!r} does not exist")
        return self.put(key, payload)

    def put(self, key: str, payload: str) -> str:
        self.versions.setdefault(key, []).append(payload)
        return str(len(self.versions[key]) - 1)

    def version_of(self, key: str) -> str:
        if key not in self.versions:
            raise FileNotFoundError(f"Object {key!r} does not exist")
        return str(len(self.versions[key]) - 1)

    def list_direct(self, prefix: str) -> list[str]:
        keys: set[str] = set()
        for key in self.versions:
            if not key.startswith(prefix):
                continue
            rest = key.removeprefix(prefix)
            keys.add(prefix + rest if "/" not in rest else prefix + rest.split("/", 1)[0] + "/")
        return sorted(keys)


def load_policy() -> CreditPolicy:
    return CreditPolicy.model_validate_json(POLICY_PATH.read_text(encoding="utf-8"))


def candidate(policy: CreditPolicy, version: str) -> CreditPolicy:
    payload = policy.model_dump(mode="json")
    payload["metadata"]["version"] = version
    return CreditPolicy.model_validate(payload)


@pytest.fixture
def repository() -> ObjectPolicyRepository:
    return ObjectPolicyRepository(MemoryObjectStore(), "policies/active.json")


def test_first_version_can_be_published_before_any_pointer_exists(repository) -> None:
    # The policy id has to be resolvable from the published prefix alone.
    policy = load_policy()
    repository.publish(policy)

    assert repository.get_version(policy.metadata.version).metadata.version == (
        policy.metadata.version
    )
    with pytest.raises(FileNotFoundError):
        repository.get_active()

    repository.activate(policy.metadata.version)
    assert repository.get_active().metadata.version == policy.metadata.version


def test_publishing_the_same_version_twice_is_rejected(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    with pytest.raises(FileExistsError):
        repository.publish(policy)


def test_productive_version_is_immutable_but_candidates_are_editable(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    repository.activate(policy.metadata.version)

    with pytest.raises(PermissionError):
        repository.update(policy)

    draft = candidate(policy, "2026-09-09.2")
    repository.publish(draft)
    edited = draft.model_copy(deep=True)
    edited.nodes[edited.root_node].label = "Edited candidate"
    repository.update(edited)

    assert repository.get_version("2026-09-09.2").nodes[edited.root_node].label == (
        "Edited candidate"
    )
    assert {item["version"]: item["active"] for item in repository.list_versions()} == {
        policy.metadata.version: True,
        "2026-09-09.2": False,
    }


def test_revisions_are_addressable_by_sha(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    repository.activate(policy.metadata.version)
    draft = candidate(policy, "2026-09-09.2")
    repository.publish(draft)
    original_sha = repository._sha(draft)

    edited = draft.model_copy(deep=True)
    edited.nodes[edited.root_node].label = "Edited candidate"
    repository.update(edited)

    restored = repository.get_revision("2026-09-09.2", original_sha)
    assert restored.nodes[restored.root_node].label == draft.nodes[draft.root_node].label
    with pytest.raises(FileNotFoundError):
        repository.get_revision("2026-09-09.2", "0" * 64)


def test_updating_a_version_that_does_not_exist_raises_not_found(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    repository.activate(policy.metadata.version)
    with pytest.raises(FileNotFoundError):
        repository.update(candidate(policy, "does-not-exist"))


def test_active_pointer_reads_the_exact_version_it_recorded(repository) -> None:
    # Activating pins a version id, so a later write to the same key cannot change
    # what production resolves to.
    policy = load_policy()
    repository.publish(policy)
    pointer = repository.activate(policy.metadata.version)

    tampered = candidate(policy, policy.metadata.version).model_copy(deep=True)
    tampered.nodes[tampered.root_node].label = "Tampered after activation"
    repository.store.put(pointer["object"], tampered.model_dump_json())

    active = repository.get_active()
    assert active.nodes[active.root_node].label != "Tampered after activation"


def test_legacy_generation_pointer_is_still_understood(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    object_name = repository._object_name(policy.metadata.policy_id, policy.metadata.version)
    repository.store.put(
        "policies/active.json",
        json.dumps(
            {
                "policy_id": policy.metadata.policy_id,
                "version": policy.metadata.version,
                "object": object_name,
                "generation": repository.store.version_of(object_name),
            }
        ),
    )

    assert repository.get_active().metadata.version == policy.metadata.version


def test_store_protocol_is_satisfied_by_the_memory_store() -> None:
    store: Any = MemoryObjectStore()
    for name in ("read", "create", "replace", "put", "version_of", "list_direct"):
        assert callable(getattr(store, name))
