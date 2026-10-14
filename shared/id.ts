import { customAlphabet } from 'nanoid';

// Base62 keeps new IDs free of punctuation in URLs while retaining about 125 bits
// of randomness at NanoID's usual length. Existing IDs remain valid unchanged.
export const createId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 21);
