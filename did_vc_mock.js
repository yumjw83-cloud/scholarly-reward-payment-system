/**
 * ============================================================
 * DID/VC Mock 저자 식별 검증 실험 (Step 2)
 * ============================================================
 *
 * 실험 목적:
 *   3.2.3절 설계 및 3.3.3절 Algorithm 1 Step 3의
 *   DID/VC 기반 저자 식별·검증 흐름을 mock 환경에서 구현하고
 *   실행 가능성을 검증한다.
 *
 * 검증 항목:
 *   1. W3C DID v1.0 준거 DID 문서 생성
 *   2. mock ORCID 식별자 기반 VC(JSON-LD) 구성 및 ECDSA 서명
 *   3. SHA-256 해시 산출 → 온체인 ⑧번 앵커링값 도출
 *   4. Algorithm 1 Step 3 검증 로직 실행:
 *        (a) SHA-256(vc) == onchain_hash   [해시 일치]
 *        (b) ECDSA_Verify(issuer_pubkey)   [서명 유효성]
 *        (c) vc.target_doi == event_doi    [DOI 매칭]
 *   5. 변조 시나리오: 해시 불일치·서명 위조·DOI 불일치 탐지
 *
 * 실험 범위:
 *   - ORCID 실계정 연동 불가 → mock 식별자 사용
 *   - IPFS 실제 업로드는 Step 3(ipfs_pinata.js)에서 수행
 *   - 본 스크립트는 오프체인 해시 산출·검증 로직만 검증
 *
 * 의존 패키지:
 *   npm install @noble/secp256k1
 *
 * 실행 방법:
 *   node did_vc_mock.js
 * ============================================================
 */

"use strict"

const crypto = require("crypto")
const fs     = require("fs")

// ============================================================
// SHA-256 유틸리티 (Node.js 내장 crypto)
// ============================================================

/** Buffer/Uint8Array → SHA-256 Uint8Array */
function sha256bytes(data) {
  return new Uint8Array(crypto.createHash("sha256").update(data).digest())
}

/** 문자열·객체 → SHA-256 대문자 hex */
function sha256hex(data) {
  const str = typeof data === "string" ? data : JSON.stringify(data)
  return crypto.createHash("sha256").update(str, "utf8").digest("hex").toUpperCase()
}

/** Uint8Array → 대문자 hex */
function toHex(arr) {
  return Buffer.from(arr).toString("hex").toUpperCase()
}

/** ISO 8601 타임스탬프 */
function nowISO() { return new Date().toISOString() }

// ============================================================
// 로그 유틸리티
// ============================================================

const LOG_FILE = "did_vc_results.txt"
fs.writeFileSync(
  LOG_FILE,
  `DID/VC Mock 검증 실험\n실행시각: ${new Date().toLocaleString("ko-KR")}\n${"=".repeat(60)}\n`,
  "utf8"
)

function log(msg = "") {
  console.log(msg)
  fs.appendFileSync(LOG_FILE, msg + "\n", "utf8")
}

function logSection(title) {
  log(`\n${"─".repeat(60)}\n[${title}]\n${"─".repeat(60)}`)
}

// ============================================================
// DID 문서 생성 (W3C DID v1.0)
// ============================================================

function createDIDDocument(address, pubKeyHex) {
  const did = `did:xrpl:${address}`
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/secp256k1-2019/v1"
    ],
    "id": did,
    "verificationMethod": [{
      "id":           `${did}#key-1`,
      "type":         "EcdsaSecp256k1VerificationKey2019",
      "controller":   did,
      "publicKeyHex": pubKeyHex
    }],
    "authentication":  [`${did}#key-1`],
    "assertionMethod": [`${did}#key-1`],
    "service": [{
      "id":              `${did}#orcid`,
      "type":            "OrcidProfile",
      "serviceEndpoint": "https://orcid.org/0000-0000-0000-MOCK"
    }],
    "created": nowISO()
  }
}

// ============================================================
// VC 생성 (W3C Verifiable Credential JSON-LD)
// ============================================================

function createVC({ issuerDid, subjectDid, orcid, doi, sigHex, issuerPubHex }) {
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.org"
    ],
    "type":             ["VerifiableCredential", "ScholarlyAuthorshipCredential"],
    "id":               `urn:uuid:${crypto.randomUUID()}`,
    "issuer":           issuerDid,
    "issuanceDate":     nowISO(),
    "credentialSubject": {
      "id":    subjectDid,
      "orcid": orcid,
      "doi":   doi,
      "role":  "Author",
      "claim": "This subject authored the scholarly work identified by the DOI."
    },
    "proof": {
      "type":               "EcdsaSecp256k1Signature2019",
      "created":            nowISO(),
      "verificationMethod": `${issuerDid}#key-1`,
      "proofPurpose":       "assertionMethod",
      "publicKeyHex":       issuerPubHex,
      "jws":                sigHex
    }
  }
}

// ============================================================
// Algorithm 1 Step 3 검증 로직
// ============================================================

function verifyVC({ vcRaw, onchainHash, issuerPubKeyHex, eventTargetDoi, secp }) {
  const result = { hashMatch: false, sigValid: false, doiMatch: false }

  // (a) 해시 일치
  result.hashMatch = (sha256hex(vcRaw) === onchainHash)

  // (b) 서명 유효성 + (c) DOI 매칭
  try {
    const vc         = JSON.parse(vcRaw)
    const payloadStr = JSON.stringify(vc.credentialSubject)
    const msgHash    = sha256bytes(Buffer.from(payloadStr, "utf8"))
    const sigBytes   = Buffer.from(vc.proof.jws, "hex")
    const pubBytes   = Buffer.from(issuerPubKeyHex, "hex")

    result.sigValid = secp.verify(sigBytes, msgHash, pubBytes)
    result.doiMatch = (vc.credentialSubject.doi === eventTargetDoi)
  } catch (e) {
    log(`  검증 예외: ${e.message}`)
  }

  return result
}

// ============================================================
// 메인 실험
// ============================================================

async function main() {

  // ── noble/secp256k1 v2 초기화 ──────────────────────────
  const secp = await import("@noble/secp256k1")

  secp.hashes.sha256 = sha256bytes
  secp.hashes.hmacSha256 = (key, ...msgs) =>
    new Uint8Array(
      crypto.createHmac("sha256", key)
            .update(Buffer.concat(msgs.map(m => Buffer.from(m))))
            .digest()
    )

  log("실험 환경: mock ORCID 식별자 사용 (ORCID 실계정 연동 불가)")
  log("검증 범위: DID 생성 → VC 구성·서명 → 해시 앵커링 → 알고리즘 검증")

  // ── 1. 키 쌍 및 식별자 생성 ────────────────────────────
  logSection("1. 키 쌍 및 mock 식별자 생성")

  const authorPriv = secp.utils.randomSecretKey()
  const authorPub  = secp.getPublicKey(authorPriv, true)
  const issuerPriv = secp.utils.randomSecretKey()
  const issuerPub  = secp.getPublicKey(issuerPriv, true)

  const authorAddr = "rMockAuthor" + toHex(authorPub).slice(0, 8)
  const issuerAddr = "rMockIssuer" + toHex(issuerPub).slice(0, 8)
  const authorDid  = `did:xrpl:${authorAddr}`
  const issuerDid  = `did:xrpl:${issuerAddr}`
  const mockOrcid  = "https://orcid.org/0000-0002-MOCK-0001"
  const targetDoi  = "10.1234/mock.dissertation.2026"

  log(`  저자 DID    : ${authorDid}`)
  log(`  발급자 DID  : ${issuerDid}`)
  log(`  mock ORCID  : ${mockOrcid}`)
  log(`  대상 DOI    : ${targetDoi}`)

  // ── 2. DID 문서 생성 ───────────────────────────────────
  logSection("2. DID 문서 생성 (W3C DID v1.0)")

  const didDoc     = createDIDDocument(authorAddr, toHex(authorPub))
  const didDocHash = sha256hex(JSON.stringify(didDoc, null, 2))

  log(`  DID 식별자           : ${didDoc.id}`)
  log(`  온체인 ② 앵커링 해시 : ${didDocHash}`)

  // ── 3. VC 생성 및 ECDSA 서명 ──────────────────────────
  logSection("3. VC 생성 및 ECDSA 서명 (발급자 키)")

  const vcSubjectStr  = JSON.stringify({
    id: authorDid, orcid: mockOrcid, doi: targetDoi,
    role: "Author",
    claim: "This subject authored the scholarly work identified by the DOI."
  })
  const vcPayloadHash = sha256bytes(Buffer.from(vcSubjectStr, "utf8"))
  const vcSigBytes    = secp.sign(vcPayloadHash, issuerPriv)
  const vcSigHex      = toHex(vcSigBytes)

  const vc       = createVC({
    issuerDid, subjectDid: authorDid,
    orcid: mockOrcid, doi: targetDoi,
    sigHex: vcSigHex, issuerPubHex: toHex(issuerPub)
  })
  const vcRawStr = JSON.stringify(vc, null, 2)
  const vcHash   = sha256hex(vcRawStr)

  log(`  VC 생성 완료`)
  log(`  서명 길이             : ${vcSigBytes.length} bytes (ECDSA compact)`)
  log(`  온체인 ⑧ 앵커링 해시 : ${vcHash}`)

  // ── 4. 정상 시나리오 ───────────────────────────────────
  logSection("4. 정상 시나리오 — Algorithm 1 Step 3")

  const r1 = verifyVC({
    vcRaw: vcRawStr, onchainHash: vcHash,
    issuerPubKeyHex: toHex(issuerPub),
    eventTargetDoi: targetDoi, secp
  })

  log(`  (a) SHA-256 해시 일치 : ${r1.hashMatch ? "PASS ✅" : "FAIL ❌"}`)
  log(`  (b) ECDSA 서명 유효성 : ${r1.sigValid  ? "PASS ✅" : "FAIL ❌"}`)
  log(`  (c) DOI 매칭          : ${r1.doiMatch  ? "PASS ✅" : "FAIL ❌"}`)
  const normal = r1.hashMatch && r1.sigValid && r1.doiMatch
  log(`  → 판정: ${normal ? "CONDITION_MET ✅" : "REJECTED ❌"}`)

  // ── 5. 변조 시나리오 1: VC 원문 위변조 ────────────────
  logSection("5. 변조 시나리오 1 — VC 원문 위변조 탐지")

  const tampered1 = vcRawStr.replace(mockOrcid, "https://orcid.org/FAKE-ORCID")
  const r2 = verifyVC({
    vcRaw: tampered1, onchainHash: vcHash,
    issuerPubKeyHex: toHex(issuerPub),
    eventTargetDoi: targetDoi, secp
  })
  log(`  (a) 해시 불일치 탐지  : ${!r2.hashMatch ? "탐지 ✅" : "미탐지 ❌"}`)
  log(`  → 판정: ${!r2.hashMatch ? "REJECTED ✅ (정상 탐지)" : "CONDITION_MET ❌"}`)

  // ── 6. 변조 시나리오 2: 서명 위조 ─────────────────────
  logSection("6. 변조 시나리오 2 — 서명 위조 탐지")

  const fakePriv   = secp.utils.randomSecretKey()
  const fakeSig    = secp.sign(vcPayloadHash, fakePriv)
  const fakeVc     = { ...vc, proof: { ...vc.proof, jws: toHex(fakeSig) } }
  const fakeVcStr  = JSON.stringify(fakeVc, null, 2)
  const fakeVcHash = sha256hex(fakeVcStr)

  const r3 = verifyVC({
    vcRaw: fakeVcStr, onchainHash: fakeVcHash,
    issuerPubKeyHex: toHex(issuerPub),
    eventTargetDoi: targetDoi, secp
  })
  log(`  (b) 서명 위조 탐지    : ${!r3.sigValid ? "탐지 ✅" : "미탐지 ❌"}`)
  log(`  → 판정: ${!r3.sigValid ? "REJECTED ✅ (정상 탐지)" : "CONDITION_MET ❌"}`)

  // ── 7. 변조 시나리오 3: DOI 불일치 ────────────────────
  logSection("7. 변조 시나리오 3 — DOI 불일치 탐지")

  const r4 = verifyVC({
    vcRaw: vcRawStr, onchainHash: vcHash,
    issuerPubKeyHex: toHex(issuerPub),
    eventTargetDoi: "10.9999/fake.doi.2026",
    secp
  })
  log(`  (c) DOI 불일치 탐지   : ${!r4.doiMatch ? "탐지 ✅" : "미탐지 ❌"}`)
  log(`  → 판정: ${!r4.doiMatch ? "REJECTED ✅ (정상 탐지)" : "CONDITION_MET ❌"}`)

  // ── 8. 파일 저장 및 결과 요약 ─────────────────────────
  logSection("8. 실험 결과 요약")

  const allPass = normal && !r2.hashMatch && !r3.sigValid && !r4.doiMatch

  log(`  정상 시나리오  : ${normal        ? "PASS" : "FAIL"}`)
  log(`  변조탐지_해시  : ${!r2.hashMatch  ? "탐지성공" : "탐지실패"}`)
  log(`  변조탐지_서명  : ${!r3.sigValid   ? "탐지성공" : "탐지실패"}`)
  log(`  변조탐지_DOI   : ${!r4.doiMatch   ? "탐지성공" : "탐지실패"}`)
  log(`  VC 온체인 해시 : ${vcHash}`)
  log(`  DID 온체인 해시: ${didDocHash}`)

  fs.writeFileSync("did_document.json", JSON.stringify(didDoc, null, 2), "utf8")
  fs.writeFileSync("vc_document.json",  JSON.stringify(vc,     null, 2), "utf8")
  fs.writeFileSync("vc_hashes.json", JSON.stringify({
    vc_sha256:     vcHash,
    did_sha256:    didDocHash,
    target_doi:    targetDoi,
    subject_did:   authorDid,
    issuer_did:    issuerDid,
    issuer_pubkey: toHex(issuerPub)
  }, null, 2), "utf8")

  log("")
  log("저장 파일:")
  log("  did_document.json  — DID 문서 (Step 3 IPFS 업로드 대상)")
  log("  vc_document.json   — VC 원문  (Step 3 IPFS 업로드 대상)")
  log("  vc_hashes.json     — 온체인 앵커링 해시값 (Step 3 연동용)")
  log("  did_vc_results.txt — 본 실험 결과 로그")
  log("")
  log(allPass
    ? "=== 모든 검증 통과 — 4.2.2절 DID/VC 기능 검증 완료 ✅ ==="
    : "=== 일부 검증 실패 — 코드 점검 필요 ❌ ===")
}

main().catch(err => {
  console.error("오류:", err)
  process.exit(1)
})
