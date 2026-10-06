import { afterEach, describe, expect, it, vi } from "vite-plus/test";

async function legalDocumentsFor(site: string) {
  vi.stubEnv("EXPO_PUBLIC_MARKETING_SITE_URL", site);
  vi.resetModules();
  return import("./legal-document-url");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("legal document destinations", () => {
  it("does not send source builds to upstream legal pages", async () => {
    const documents = await legalDocumentsFor("");
    expect(documents.LEGAL_URL).toBeNull();
    expect(documents.ALLOWED_LEGAL_DOCUMENT_URLS).toEqual([]);
    expect(documents.isLegalDocumentUrl("https://rove.hafiezulzikry.com/legal")).toBe(false);
  });

  it("uses only the configured site's legal documents", async () => {
    const documents = await legalDocumentsFor("https://rove.example.test/docs/?campaign=app");
    expect(documents.LEGAL_URL).toBe("https://rove.example.test/docs/legal");
    for (const path of [
      "legal/",
      "privacy-policy?source=app",
      "terms-of-service#updates",
      "security-policy",
    ]) {
      expect(documents.isLegalDocumentUrl(`https://rove.example.test/docs/${path}`)).toBe(true);
    }
    for (const url of [
      "https://rove.example.test/docs/download",
      "https://rove.hafiezulzikry.com/legal",
      "javascript:alert(1)",
      "not-a-url",
    ]) {
      expect(documents.isLegalDocumentUrl(url)).toBe(false);
    }
  });

  it.each([
    "https://rove.hafiezulzikry.com",
    "https://clerk.rove.codes",
    "javascript:alert(1)",
    "broken-url",
  ])("rejects an upstream or invalid legal base: %s", async (site) => {
    const documents = await legalDocumentsFor(site);
    expect(documents.LEGAL_URL).toBeNull();
    expect(documents.isLegalDocumentUrl("https://rove.hafiezulzikry.com/legal")).toBe(false);
  });
});
