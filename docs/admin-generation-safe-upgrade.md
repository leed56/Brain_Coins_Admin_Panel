# Admin Generation Safe Upgrade

This branch is created to improve the BrainCoins admin generation system without changing the current main branch structure.

## Phase 1 fixes
- Keep existing admin UI flow.
- Keep existing database schema.
- Normalize FIB and FIIB safely.
- Use per-type counts for MCQ, FIIB, TF, and HOQ.
- Prevent duplicate clicks and duplicate saves.
- Improve error messages.

## Phase 2 enhancements
- Add generation style selector.
- Add subject-wise rubric support.
- Add Islam exam-paper style rules.
- Add quality score before saving.
- Add review status workflow.
- Add generation progress UI.

## Safety rule
Do not touch student app flow. Only improve admin panel generation and review workflow.
