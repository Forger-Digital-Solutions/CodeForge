# R53 Reviewer pool independence and quality

The Free Fabric previously sorted an independent physical pool ahead of every same-pool Reviewer, even when the independent route had a much lower quality score or only a probation role verdict. R53 now orders by admitted supply domain and role qualification tier, then adds a bounded ten-point independence preference to the effective role score. Ten points is smaller than the existing maximum ±16 runtime role-evidence swing, so repeated verified quality evidence can outweigh pool independence. Capacity reservation and ForgeZero policy still determine whether a ranked route can actually serve.

The `r24-multi-pool` regression now proves that a comparable independent Reviewer wins, a 50-point independent Reviewer does not displace a 95-point same-pool Reviewer, probation does not displace qualified, and an unavailable independent pool yields to the next admissible route. The server's real turn wiring test uses a near-quality pair and confirms that a review turn reaches the independent pool after a prior implementation turn. This is a preference, not a mandatory isolation rule; selected same-pool reviews still report `SAME_POOL_FALLBACK`.

The change is confined to 8-Bit Free Fabric routing. Paid 16-Bit selection and ForgeVerify completion policy are untouched.
