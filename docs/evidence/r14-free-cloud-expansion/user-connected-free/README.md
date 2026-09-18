# Ollama user-connected Free Cloud evidence

This folder records the R14 follow-up implementation for the user-owned Ollama Cloud path. It is
separate from the managed Free fleet: a connected account remains an individual user's capacity
pool and is never aggregated into CodeForge-owned capacity.

- [Technical design](technical-design.md)
- [Security boundary](security.md)
- [Capacity and adoption model](capacity.md)
- [UX flow](ux.md)
- [Terms and release gate](terms.md)

The implementation is behind `CODEFORGE_OLLAMA_USER_CONNECTED_FREE=1`. It remains excluded from
public ForgeAuto/Free until the free-only hard-stop, provider permission, usage observation, and
8-Bit role qualification gates are independently certified.
