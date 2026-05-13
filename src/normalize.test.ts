import { describe, it, expect } from "vitest";
import { looksLikeInternalId, looksLikeINN } from "./normalize";

describe("looksLikeInternalId", () => {
  it("recognizes simple letter+digit codes", () => {
    expect(looksLikeInternalId("MK3475")).toBe(true);
    expect(looksLikeInternalId("MK-3475")).toBe(true);
    expect(looksLikeInternalId("AZD9291")).toBe(true);
    expect(looksLikeInternalId("BA3011")).toBe(true);
  });

  it("recognizes codes with trailing letters (ASG22CE, AGS22ME)", () => {
    expect(looksLikeInternalId("ASG22CE")).toBe(true);
    expect(looksLikeInternalId("AGS22ME")).toBe(true);
    expect(looksLikeInternalId("ASG-22CE")).toBe(true);
  });

  it("rejects plain English words and INNs", () => {
    expect(looksLikeInternalId("aspirin")).toBe(false);
    expect(looksLikeInternalId("pembrolizumab")).toBe(false);
  });
});

describe("looksLikeINN", () => {
  it("accepts -mab / -nib / -tinib", () => {
    expect(looksLikeINN("pembrolizumab")).toBe(true);
    expect(looksLikeINN("osimertinib")).toBe(true);
  });

  it("rejects ids and brand-cased tokens", () => {
    expect(looksLikeINN("MK-3475")).toBe(false);
    expect(looksLikeINN("Cytoxan")).toBe(false);
  });
});
