export type ImageInsight = {
  url: string;
  hasVisibleText?: boolean;
  dominantColor?: string;
  role?: string;
  originalRole?: string; // Phase 5a.1: Immutable Vision ground truth
  roleScore?: number; // NEW: −1..+1 backness score
  evidenceTriggers?: string[]; // NEW: exact matched keywords/visual cues
  ocrText?: string;
  textBlocks?: string[];
  text?: string;
  ocr?: {
    text?: string;
    lines?: string[];
  };
  textExtracted?: string;
  visualDescription?: string;
};
