export function normalizeWord(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`.-]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase();
}
