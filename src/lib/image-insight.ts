export type ImageInsight = {
  url: string;
  hasVisibleText?: boolean;
  dominantColor?: string;
  role?: string;
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
