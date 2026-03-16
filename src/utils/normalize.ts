/** Normalize a string for comparison: lowercase, trim, collapse internal whitespace. */
export function normalizeString(value: string): string {
    return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Divide a raw integer string by 10^decimals to produce a human-readable decimal string. */
export function scaleDown(raw: string, decimals: number): string {
    if (decimals === 0) return raw;
    const padded = raw.padStart(decimals + 1, '0');
    const intPart = padded.slice(0, -decimals);
    const fracPart = padded.slice(-decimals).replace(/0+$/, '');
    return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** Multiply a human-readable decimal string by 10^decimals to produce a raw integer string. */
export function scaleUp(value: string, decimals: number): string {
    if (!value.includes('.')) return value;
    if (decimals === 0) return value.replace('.', '');
    const [intPart, fracPart = ''] = value.split('.');
    const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
    const raw = (intPart + padded).replace(/^0+/, '') || '0';
    return raw;
}
