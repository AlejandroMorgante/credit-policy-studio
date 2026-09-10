from __future__ import annotations

import operator
from collections.abc import Callable, Mapping
from typing import Any


def _ordered(comparison: Callable[[Any, Any], bool]) -> Callable[[Any, Any], bool]:
    return lambda left, right: False if left is None or right is None else comparison(left, right)


COMPARISONS: dict[str, Callable[[Any, Any], bool]] = {
    "lt": _ordered(operator.lt),
    "lte": _ordered(operator.le),
    "gt": _ordered(operator.gt),
    "gte": _ordered(operator.ge),
    "eq": operator.eq,
    "neq": operator.ne,
    "in": lambda observed, expected: observed in expected,
}

ARITIES = {
    "lt": 2,
    "lte": 2,
    "gt": 2,
    "gte": 2,
    "eq": 2,
    "neq": 2,
    "in": 2,
    "not": 1,
    "is_null": 1,
    "is_not_null": 1,
    "add": 2,
    "sub": 2,
    "mul": 2,
    "int": 1,
    "if": 3,
}


def validate(expression: Any) -> None:
    if not isinstance(expression, dict):
        return
    if set(expression) == {"field"}:
        if not isinstance(expression["field"], str) or not expression["field"]:
            raise ValueError("expression field must be a non-empty string")
        return
    if set(expression) != {"op", "args"}:
        raise ValueError("expression requires exactly op/args or field")
    op, args = expression["op"], expression["args"]
    if not isinstance(op, str) or not isinstance(args, list):
        raise ValueError("expression op must be a string and args must be a list")
    if op in {"and", "or", "min", "max"}:
        if not args:
            raise ValueError(f"expression operator {op!r} requires at least one argument")
    elif op not in ARITIES:
        raise ValueError(f"unsupported expression operator {op!r}")
    elif len(args) != ARITIES[op]:
        raise ValueError(f"expression operator {op!r} expects {ARITIES[op]} arguments")
    for argument in args:
        validate(argument)


def _field(context: Mapping[str, Any], path: str) -> Any:
    value: Any = context
    for part in path.split("."):
        if value is None:
            return None
        if isinstance(value, Mapping):
            value = value.get(part)
        else:
            value = getattr(value, part, None)
    return value


def evaluate(expression: Any, context: Mapping[str, Any]) -> Any:
    """Evaluate the deliberately small, data-only policy expression language."""
    if not isinstance(expression, dict):
        return expression
    if set(expression) == {"field"}:
        return _field(context, str(expression["field"]))
    op = expression.get("op")
    args = expression.get("args", [])
    if not isinstance(op, str) or not isinstance(args, list):
        raise ValueError(f"Invalid expression {expression!r}")
    if op == "if":
        if len(args) != 3:
            raise ValueError("if expects condition, true value and false value")
        return (
            evaluate(args[1], context) if evaluate(args[0], context) else evaluate(args[2], context)
        )
    values = [evaluate(arg, context) for arg in args]
    if op in COMPARISONS:
        return COMPARISONS[op](*values)
    if op == "and":
        return all(values)
    if op == "or":
        return any(values)
    if op == "not":
        return not values[0]
    if op == "is_null":
        return values[0] is None
    if op == "is_not_null":
        return values[0] is not None
    if op == "add":
        return values[0] + values[1]
    if op == "sub":
        return values[0] - values[1]
    if op == "mul":
        return values[0] * values[1]
    if op == "min":
        return min(values)
    if op == "max":
        return max(values)
    if op == "int":
        return int(values[0])
    raise ValueError(f"Unsupported expression operator {op!r}")
