export function parallelProviderRendezvous(): () => Promise<void> {
  let arrivals = 0;
  let release: () => void = () => undefined;
  const bothArrived = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    if (++arrivals >= 2) release();
    // A rendezvous proves concurrent dispatch without depending on a 25 ms IO scheduling gap.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothArrived,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Parallel provider dispatch did not rendezvous")), 2_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
