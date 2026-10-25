/** Shared entrance animations, defined once so motion props aren't re-created on every render. */
export const fadeUpSm = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } } as const;
export const fadeUp = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } as const;
export const fadeUpLg = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } } as const;
export const quick = { duration: 0.18 } as const;
export const settle = { duration: 0.3 } as const;
