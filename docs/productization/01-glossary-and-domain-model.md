# ACU Router Productization Domain Model

## Purpose

This document defines the core objects and boundaries of ACU Router. The goal is to avoid ambiguity during product engineering between conversation, task, model request, tool execution, routing and evaluation.

## Core hierarchy

```
User
└── API Key
    └── Session
        └── Task / Goal
            └── Routing Segment
                └── Step
                    └── Tool Event
```

## User / API Key

User represents an account. API Key is the access credential used by Codex, Claude Code or other compatible clients.

Explicit model selection belongs to the user. ACU only changes routing when the user selects `acu-auto` or similar automatic modes.

## Session

A Session represents a continuous client conversation or execution context.

Session is not equal to routing state. A Session may contain multiple goals and multiple routing segments.

## Task / Goal

A semantic objective being completed.

Example:

```
Fix authentication refresh token compatibility issue
```

A Task can continue through multiple client turns or autonomous agent steps.

## Turn

Turn remains a conversation concept but is NOT the primary routing boundary.

Reasons:

- Coding agents may create multiple internal turns under one goal.
- Tool results may appear as messages but are not human inputs.
- Different clients expose different turn semantics.

## Routing Segment

Routing Segment is the fundamental ACU routing unit.

It represents a continuous sequence of Steps sharing:

- difficulty evaluation;
- quality target;
- execution profile;
- routing decision.

A new segment is created when:

- task goal changes;
- planning starts or ends;
- replanning occurs;
- capability blocking occurs;
- routing lease expires;
- compatibility requirements change.

Within one segment, automatic routing may maintain or upgrade quality, but does not downgrade.

## Step

One actual model inference request.

A single segment may contain many steps:

```
Analyze → Read → Search → Edit → Test → Repair
```

## Tool Event

Tool calls and results, including:

- file read/write;
- bash;
- search;
- test/build results;
- function calls.

Tool events do not automatically trigger new routing evaluation.

## Judge Evaluation

Judge evaluates the next required capability based on:

- current API input;
- task context;
- previous attempts;
- success/failure evidence;
- user feedback;
- execution history.

Future architecture may split this into:

- Q-Context: context understanding;
- Q-Difficulty: capability demand estimation.

The first version keeps them together inside LLM Judge.

## Judge Context Envelope

The Judge receives:

1. Original client API input.
2. Session/task state stored by ACU.
3. Previous routing decision.
4. Active plan information.
5. Recent steps.
6. Recent tool events.
7. Error and success evidence.
8. User satisfaction signals.
9. Current execution profile.

ACU is not the coding agent. It cannot assume custom fields from Codex or Claude Code and must work from native API traffic.

## Routing Lease

A routing decision remains valid while:

```
current_time - last_activity_time <= 10 minutes
```

Any valid activity renews the lease:

- model request;
- streaming response;
- tool call;
- tool result;
- user input.

The Session itself does not expire.

## Product invariants

1. User-selected models are not replaced.
2. Only automatic routing modes invoke ACU decisions.
3. New tasks may choose lower or higher quality.
4. Explicit failures and blockers can trigger re-evaluation.
5. Full execution records are stored for future optimization.
6. PostgreSQL is the long-term data layer.
