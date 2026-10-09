export async function retry(operation, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await operation(); } catch (error) { if (attempt + 1 >= maxAttempts) throw error; }
  }
}
