export async function openPathChecked(path: string, open: (path: string) => Promise<string>) {
  const error = await open(path)
  if (error) throw new Error(error)
}
