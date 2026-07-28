# ACU Router Session Task Routing Segment State Machine

## Goal

Define when ACU evaluates difficulty, when routing is reused, and when the system changes execution strategy.

## State hierarchy

```
Session
  ↓
Task / Goal
  ↓
Routing Segment
  ↓
Step
  ↓
Tool Event
```

## Main flow

```
Receive native API request
        ↓
Identify session/task context
        ↓
Determine routing segment
        ↓
Check evaluation triggers
        ↓
Reuse route OR run Judge
        ↓
Execute model
        ↓
Store step, result and evidence
```

## Judge triggers

A new Judge evaluation is required for:

- new task or changed goal;
- new external user requirement;
- planning/replanning events;
- clear capability blocking;
- expired routing lease;
- strong user dissatisfaction signals;
- major context or compatibility changes.

A normal Tool Result, Read, Search, Edit or single failed test does not automatically trigger Judge.

## Same segment rules

Within one Routing Segment:

- keep current execution profile;
- allow upgrade;
- do not automatically downgrade.

This prevents oscillation during complex coding tasks.

## Planning handling

Planning receives temporary quality priority.

Example:

```
Task quality target: 80
Planning segment target: 88
```

After reliable planning completion, a new execution segment may return to the task baseline.

This is not a downgrade inside one segment; it is a new segment with a new decision.

Automatic downgrade is avoided when planning completion cannot be reliably detected.

## User input handling

A short message such as:

```
continue
```

must not be evaluated alone.

Judge receives the complete context envelope including:

- original goal;
- previous execution state;
- recent failures/successes;
- previous routing decision.

## Goal mode support

Coding agents may execute multiple internal turns without new human messages.

Therefore ACU does not rely only on human turns. It identifies meaningful task transitions through:

- native protocol information;
- context continuity;
- plan changes;
- execution evidence.

## Failure handling

### Capability failures

Examples:

- repeated same error;
- repeated unsuccessful repair;
- inability to complete required tool action;
- user explicitly reports failure.

These may trigger Judge and possible upgrade.

### Provider failures

Examples:

- timeout;
- 429;
- 5xx;
- provider unavailable.

These are infrastructure problems, not task difficulty changes.

First handling should be channel/provider recovery rather than model downgrade.

## Routing lease

Default lease:

```
10 minutes
```

Any valid activity renews lease.

After expiration:

- Session remains;
- Task remains;
- next execution request runs Judge again.

## Explicit model mode

When users select a concrete model:

```
claude-x
GPT-x
```

ACU does not perform model routing.

The first product phase focuses on:

```
acu-auto
acu-high
```

## First phase implementation principle

Prefer:

- deterministic rules;
- complete logging;
- explainable routing;
- data accumulation.

Avoid premature complexity such as:

- autonomous model switching after every error;
- local routing model training;
- hidden behavior changes.

The future optimization loop is based on real user execution data stored by ACU.
