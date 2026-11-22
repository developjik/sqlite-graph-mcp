export async function load(): Promise<number> {
  const { dynFn } = await import('./dynmod');
  return dynFn();
}

// An `import()` nested inside a function body binds nothing: `lazy` is the
// factory, not the module. No default-export reference may be produced.
export const lazy = () => import('./dynmod');
