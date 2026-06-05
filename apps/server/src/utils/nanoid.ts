import { customAlphabet } from "nanoid";

const alphabets = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const generateId = customAlphabet(alphabets, 24);
