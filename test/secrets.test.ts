import { describe, expect, test } from "bun:test"
import { scanForSecret } from "../src/secrets"

describe("scanForSecret", () => {
  test("detects an AWS access key id", () => {
    expect(scanForSecret("creds: AKIAIOSFODNN7EXAMPLE ok")?.kind).toBe("aws-access-key-id")
  })

  test("detects a PEM private key header", () => {
    expect(scanForSecret("-----BEGIN RSA PRIVATE KEY-----")?.kind).toBe("private-key-pem")
  })

  test("detects a Bearer token", () => {
    expect(scanForSecret("Authorization: Bearer sk0123456789abcdefghijABCDEF")?.kind).toBe("bearer-token")
  })

  test("detects an assigned api key", () => {
    expect(scanForSecret('api_key = "sk-abcdef0123456789ABCDEF"')).not.toBeNull()
  })

  test.each([
    [`sk-proj-${"A1".repeat(16)}`, "openai-token"],
    [`sk-live-${"B2".repeat(16)}`, "openai-token"],
    [`sk-${"c3".repeat(16)}`, "openai-token"],
    ["postgres://admin:password@database.example/app", "uri-credentials"],
    [`github_pat_${"A1".repeat(20)}`, "github-token"],
    ["password = hunter22", "assigned-secret"],
  ])("detects reviewed bypass %p", (value, kind) => {
    expect(scanForSecret(value)?.kind).toBe(kind)
  })

  test("allows clean prose", () => {
    expect(scanForSecret("The user prefers pnpm over npm and wants terse replies.")).toBeNull()
  })

  test("allows a normal file path", () => {
    expect(scanForSecret("handlers live in src/api/handlers/user.ts")).toBeNull()
  })
})
