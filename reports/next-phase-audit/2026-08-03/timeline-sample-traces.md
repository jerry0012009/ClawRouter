# Desensitized sample traces

IDs retain only a short prefix/suffix. No prompts, responses, user IDs, tokens or payloads were read into this report.

1. `req_bd9449...516c`  
Step -> new task -> Judge live (1 attempt, D13, confidence .98) -> inspection -> offset -4 -> Luna Max -> preset max -> existing Luna Profile `lucen-cx010-plus-fast` -> no retry -> success. Usage: 3,840 cached input, 16 reasoning tokens. Timeline shows difficulty/model/cost but not inspection, offset, Preset or Effort.

2. `req_40acaa...36fd`  
Step -> plan started -> Judge live (1 attempt, D20) -> planning -> offset +4 -> Luna Max -> preset max -> existing Luna Profile `lucen-cx010-plus-fast` -> no retry -> success. Current Timeline cannot distinguish Luna Max from base Luna.

3. `req_767c8a...e671`  
Step -> lease-expired trigger -> 3 Judge calls -> all fail -> recent evaluation reused (D78.4) -> inspection -> offset -4 -> Sol -> default effort -> `lucen-cx008-plus-dedicated` -> no Provider retry -> success. Timeline's `judgeCalled` boolean cannot show the three-attempt failure chain or result source.

4. `req_81fe30...5fd0`  
Step -> reuse route -> Judge calls 0, reused true -> associated evaluation source recent evaluation -> inspection -> offset -4 -> Sol -> same existing Profile -> success. This is **not** a Judge failure on this request. Timeline can show Reuse but not the source it reused.

5. `req_cc5e97...6d1b`  
Step -> new task -> 3 Judge attempts -> rules fallback (D42/.65) -> inspection -> offset -4 -> Sol -> `lucen-cx008-plus-dedicated` -> no Provider retry -> success. Timeline does not expose rules strategy or the Judge Profile chain.

6. `req_4e4513...4cf7`  
Step -> explicit model -> Judge calls 0 (not Reuse) -> general -> no offset -> explicit Luna/max passthrough -> `lucen-cx010-plus-fast` failed before model output -> same-model Luna Profile retry -> success. Session Trace shows Provider Attempts, but Timeline collapses the route and does not show passthrough Effort semantics.

These six traces cover all requested categories with overlap: Judge New, Judge Reused, inspection, planning, Luna Max, Profile retry/recovery and rules fallback.
