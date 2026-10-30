# @re0/verifier

Independent anchor verifier.

Given a citation's asset id, version and chunk digests, it reads the batch
Merkle root from Aptos mainnet and recomputes the proof locally.

**It must not import anything from `lib/`.** The whole point is that verification
does not depend on re0 — see architecture.md 8.5 and the acceptance criterion
"校验过程不调用 re0 任何接口".
