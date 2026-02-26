const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";
export const authHeaders: Record<string, string> = API_KEY ? { "x-api-key": API_KEY } : {};
export const API_BASE = API_URL;
