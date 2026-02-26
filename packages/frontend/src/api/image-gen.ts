import { API_BASE, authHeaders } from "./client";

// ─── Image Generation Config ─────────────────────────────────────────────

export type ImageGenerationConfig = {
  enabled: boolean;
  minScore: number;
  quality: string;
  size: string;
  prompt: string;
};

export type ImageTemplateConfig2 = {
  titlePosition: { x: number; y: number };
  titleAlignment: "left" | "center" | "right";
  titleMaxWidth: number;
  titleFontSize: number;
  titleFontFamily: string;
  titleColor: string;
  backdropEnabled: boolean;
  backdropColor: string;
  backdropPadding: number;
  backdropBorderRadius: number;
  watermarkPosition: { x: number; y: number };
  watermarkScale: number;
};

export const getImageGenerationConfig = async (): Promise<ImageGenerationConfig> => {
  const res = await fetch(`${API_BASE}/config/image-generation`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get image generation config");
  return res.json();
};

export const updateImageGenerationConfig = async (
  config: Partial<ImageGenerationConfig>,
): Promise<void> => {
  const res = await fetch(`${API_BASE}/config/image-generation`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to update image generation config");
};

export const getImageTemplate = async (): Promise<ImageTemplateConfig2> => {
  const res = await fetch(`${API_BASE}/config/image-template`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error("Failed to get image template");
  return res.json();
};

export const updateImageTemplate = async (template: ImageTemplateConfig2): Promise<void> => {
  const res = await fetch(`${API_BASE}/config/image-template`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
  if (!res.ok) throw new Error("Failed to update image template");
};
