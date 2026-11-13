export type ClassValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ClassDictionary
  | ClassArray;
export type ClassDictionary = Record<string, unknown>;
export type ClassArray = ClassValue[];

function toClassString(value: ClassValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value ? String(value) : '';
  if (!value || typeof value !== 'object') return '';

  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const part = toClassString(item);
      if (part) parts.push(part);
    }
  } else {
    for (const key of Object.keys(value)) {
      if ((value as ClassDictionary)[key]) parts.push(key);
    }
  }
  return parts.join(' ');
}

/** Minimal local replacement for the `clsx` package. */
export function clsx(...inputs: ClassValue[]): string {
  return toClassString(inputs);
}
