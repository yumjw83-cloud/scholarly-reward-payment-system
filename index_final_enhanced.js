/**
 * ============================================================
 * XRPL 기반 DID/VC/오라클 연동 에스크로 실험 코드 (Enhanced)
 * ============================================================
 *
 * 기존 index_final_refined.js 대비 보강 사항:
 *
 *   1. 오라클: 모의 입력 → 실제 Crossref API 호출
 *      - https://api.crossref.org/works/{DOI} 를 호출하여
 *        DOI 등록 여부, 콘텐츠 유형, 출판 일자를 확인한다.
 *      - 세 조건 모두 충족 시 "게재 이벤트 감지(event_detected)"
 *        로 판정한다. 이는 "학술적 품질 보증"과 구별된다.
 *      - Crossref는 메타데이터 등록 서비스이지 검증 기관이 아니다.
 *
 *   2. DID: did:example: → did:key: 방식
 *      - Ed25519 공개키를 DID 문자열 자체에 인코딩하여
 *        외부 레지스트리 없이 자체 검증 가능한 구조를 구현한다.
 *
 *   3. 증거 보존: 매 실행의 DID 문서, VC, 오라클 이벤트를
 *      evidence/ 디렉토리에 JSON 파일로 저장한다.
 *
 * ※ 프로토타입의 범위와 한계:
 *   - 본 코드는 완전한 상용 학술 검증 시스템이 아닌, 외부 학술
 *     이벤트와 온체인 지급 간의 '연계 구조(linkage structure)'가
 *     기술적으로 성립함을 확인하는 개념 증명(PoC)이다.
 *   - 오라클은 단일 주체(single oracle)로 구동되며, 실제 환경에서는
 *     다중 검증 기관이 참여하는 탈중앙화 오라클 네트워크(DON)
 *     또는 연합 기반 신뢰 구조로 확장되어야 한다.
 *   - XRPL Testnet 환경이며, Mainnet과 응답 시간이 다를 수 있다.
 *
 * 의존 패키지:
 *   xrpl (npm install xrpl)
 *   (Node.js 18+ 내장 fetch 사용, 별도 설치 불필요)
 *
 * 실행 방법:
 *   node index_final_enhanced.js
 * ============================================================
 */

"use strict"

const xrpl   = require("xrpl")
const crypto = require("crypto")
const fs     = require("fs")
const path   = require("path")

// ============================================================
// 실험 설정
// ============================================================

const XRPL_SERVER            = "wss://s.altnet.rippletest.net:51233"
const TOTAL_RUNS             = 100
const OUTPUT_CSV             = "xrpl_results_enhanced.csv"
const EVIDENCE_DIR           = "evidence"
const ESCROW_AMOUNT_XRP      = "1"
const CANCEL_AFTER_MS        = 24 * 60 * 60 * 1_000
const SLEEP_BETWEEN_RUNS_MS  = 1_000
const FUND_WALLET_MAX_RETRIES = 3
const RETRY_DELAY_MS         = 1_500
const CROSSREF_TIMEOUT_MS    = 10_000

/**
 * 실험에 사용할 실제 DOI 풀.
 * Crossref API에서 실제 메타데이터를 반환하는 공개 논문들이다.
 * 100회 반복 시 순환 사용된다.
 */
const DOI_POOL = [
  "10.1038/nature12373",       // Nature - ENCODE project
  "10.1126/science.1058040",   // Science - Human genome
  "10.1371/journal.pone.0001636",  // PLOS ONE
  "10.1016/j.cell.2015.04.044",    // Cell
  "10.1038/s41586-020-2649-2",     // Nature - GPT-3
  "10.1145/3442188.3445922",       // ACM FAccT - Stochastic Parrots
  "10.1007/s10961-019-09768-3",    // J. Technology Transfer (한국 기술이전)
  "10.1016/j.respol.2009.07.002",  // Research Policy - Bayh-Dole
  "10.1287/isre.13.3.334.78",      // ISR - Parasuraman TRI
  "10.1016/j.elerap.2007.02.001",  // Kim et al. VAM
]

// ============================================================
// 유틸리티
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex").toUpperCase()
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]"
  const keys = Object.keys(value).sort()
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}"
}

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519")
}

function signJson(privateKey, payloadObj) {
  const data = Buffer.from(canonicalize(payloadObj))
  return crypto.sign(null, data, privateKey).toString("base64")
}

function verifyJson(publicKey, payloadObj, signatureBase64) {
  const data = Buffer.from(canonicalize(payloadObj))
  return crypto.verify(null, data, publicKey, Buffer.from(signatureBase64, "base64"))
}

// ============================================================
// did:key 구현
// ============================================================

/**
 * Ed25519 공개키로부터 did:key DID 문자열을 생성한다.
 *
 * did:key Method (W3C):
 *   1. 공개키 raw bytes(32바이트)를 추출한다.
 *   2. multicodec prefix 0xed01 (Ed25519 public key)을 앞에 붙인다.
 *   3. multibase base58btc ('z' prefix)로 인코딩한다.
 *   4. "did:key:" + 인코딩된 문자열이 DID가 된다.
 *
 * @param {crypto.KeyObject} publicKey
 * @returns {string} did:key:z6Mk...
 */
function publicKeyToDidKey(publicKey) {
  // raw 32-byte Ed25519 public key 추출
  const rawPub = publicKey.export({ type: "spki", format: "der" })
  // DER SPKI for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00 [32 bytes]
  // 마지막 32바이트가 raw public key
  const raw32 = rawPub.subarray(rawPub.length - 32)

  // multicodec: 0xed 0x01 (Ed25519 public key, varint)
  const multicodec = Buffer.from([0xed, 0x01])
  const prefixed = Buffer.concat([multicodec, raw32])

  // base58btc 인코딩 (순수 구현, 외부 의존성 없음)
  const encoded = base58btcEncode(prefixed)

  return `did:key:z${encoded}`
}

/**
 * did:key 문자열에서 Ed25519 공개키를 복원한다.
 *
 * @param {string} didKey - did:key:z6Mk...
 * @returns {crypto.KeyObject}
 */
function didKeyToPublicKey(didKey) {
  if (!didKey.startsWith("did:key:z")) {
    throw new Error(`유효하지 않은 did:key 형식: ${didKey}`)
  }

  const encoded = didKey.slice("did:key:z".length)
  const decoded = base58btcDecode(encoded)

  // multicodec prefix 검증: 0xed 0x01
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error("Ed25519 multicodec prefix 불일치")
  }

  const raw32 = decoded.subarray(2)
  if (raw32.length !== 32) {
    throw new Error(`Ed25519 공개키 길이 오류: ${raw32.length} (expected 32)`)
  }

  // DER SPKI 헤더 구성
  const spkiHeader = Buffer.from("302a300506032b6570032100", "hex")
  const spkiDer = Buffer.concat([spkiHeader, raw32])

  return crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" })
}

// Base58btc 인코딩/디코딩 (Bitcoin alphabet, 외부 의존성 없음)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

function base58btcEncode(buffer) {
  const digits = [0]
  for (const byte of buffer) {
    let carry = byte
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let result = ""
  for (const byte of buffer) {
    if (byte !== 0) break
    result += BASE58_ALPHABET[0]
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]]
  }
  return result
}

function base58btcDecode(str) {
  const bytes = [0]
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char)
    if (idx < 0) throw new Error(`유효하지 않은 base58 문자: ${char}`)
    let carry = idx
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const char of str) {
    if (char !== BASE58_ALPHABET[0]) break
    bytes.push(0)
  }
  return Buffer.from(bytes.reverse())
}

// ============================================================
// DID Document 생성 (did:key 기반)
// ============================================================

/**
 * did:key 기반 DID Document를 생성한다.
 * 외부 레지스트리 없이 DID 문자열 자체에서 공개키를 복원할 수 있다.
 *
 * @param {crypto.KeyObject} publicKey
 * @returns {{ did: string, didDocument: object }}
 */
function createDidKeyDocument(publicKey) {
  const did = publicKeyToDidKey(publicKey)
  const keyId = `${did}#key-1`

  const spkiPem = publicKey.export({ type: "spki", format: "pem" }).toString()

  const didDocument = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1"
    ],
    id: did,
    verificationMethod: [{
      id: keyId,
      type: "Ed25519VerificationKey2020",
      controller: did,
      publicKeyPem: spkiPem
    }],
    authentication: [keyId],
    assertionMethod: [keyId]
  }

  return { did, didDocument }
}

/**
 * did:key DID에서 직접 공개키를 복원하여 반환한다.
 * 외부 레지스트리 조회 없이 DID 문자열만으로 검증 가능하다.
 *
 * @param {string} did - did:key:z6Mk...
 * @returns {crypto.KeyObject}
 */
function resolveDidKeyPublicKey(did) {
  return didKeyToPublicKey(did)
}

// ============================================================
// VC 발급 / 검증 (did:key 기반)
// ============================================================

/**
 * ORCID 연동 Verifiable Credential(VC)을 발급한다.
 * W3C Verifiable Credentials Data Model 1.1 준수.
 */
function issueOrcidLinkVC({ issuerDid, issuerPrivateKey, subjectDid, orcid }) {
  const vcPayload = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1"
    ],
    type: ["VerifiableCredential", "OrcidLinkCredential"],
    issuer: issuerDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: subjectDid,
      orcid: orcid,
      orcidUri: `https://orcid.org/${orcid}`
    }
  }

  const proof = {
    type: "Ed25519Signature2020",
    created: new Date().toISOString(),
    proofPurpose: "assertionMethod",
    verificationMethod: `${issuerDid}#key-1`,
    jws: signJson(issuerPrivateKey, vcPayload)
  }

  return { ...vcPayload, proof }
}

/**
 * VC의 issuer DID(did:key)에서 공개키를 복원하여 서명을 검증한다.
 */
function verifyVcSignature(vc) {
  const { proof, ...unsignedVc } = vc
  if (!proof?.jws) throw new Error("VC proof 누락")

  // did:key에서 직접 공개키 복원 (레지스트리 불필요)
  const issuerPublicKey = resolveDidKeyPublicKey(vc.issuer)
  const ok = verifyJson(issuerPublicKey, unsignedVc, proof.jws)
  if (!ok) throw new Error("VC 서명 검증 실패")

  return true
}

// ============================================================
// Crossref API 오라클 (실제 HTTP 호출)
// ============================================================

/**
 * ※ Crossref의 역할적 한계에 대한 설계 주석
 *
 * Crossref는 국제 표준 학술 식별자(DOI) 기반의 메타데이터 등록·
 * 제공 서비스(registration agency)이다. Crossref는 논문의 학술적
 * 품질이나 동료심사(Peer Review) 진위를 직접 검증·보증하는
 * 기관이 아니다.
 *
 * 본 프로토타입에서 Crossref API는 학술 콘텐츠의 질적 검증
 * 도구가 아닌, '논문 게재라는 외부 이벤트의 발생 여부'를 시스템
 * 으로 끌어오기 위한 객관적 데이터 트리거(Data Trigger)로만
 * 활용된다. 구체적으로:
 *
 *   - DOI 존재 여부: 해당 DOI가 Crossref에 등록되어 있는가
 *   - 콘텐츠 유형: journal-article 등 유형 확인
 *   - 출판 일자 존재 여부: published-print 또는 published-online
 *     날짜가 기록되어 있는가
 *
 * 이 세 조건이 모두 충족되면 "게재 이벤트 감지(event_detected)"
 * 로 판정하며, 이는 "학술적 검증 완료"와 구별되는 개념이다.
 *
 * 실제 운영 환경에서는 다중 데이터 소스(Crossref + ORCID +
 * 학회 DB 등)를 교차 검증하는 탈중앙화 오라클 네트워크(DON)
 * 구조로 확장되어야 한다.
 */

/**
 * Crossref API에서 DOI로 논문 메타데이터를 조회한다.
 *
 * 판정 로직:
 *   - DOI가 Crossref에 등록되어 있고
 *   - type이 'journal-article', 'proceedings-article', 'book-chapter' 중 하나이며
 *   - published-print 또는 published-online 날짜가 존재하면
 *   → eventDetected = true (게재 이벤트 감지)
 *
 * eventDetected는 "학술적 품질 보증"이 아니라
 * "게재라는 외부 이벤트의 발생"만을 의미한다.
 *
 * @param {string} doi
 * @returns {Promise<object>}
 */
async function fetchCrossrefMetadata(doi) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "XRPL-Escrow-Experiment/1.0 (mailto:research@example.com)",
        "Accept": "application/json"
      },
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      return { found: false, eventDetected: false, error: `HTTP ${response.status}`, doi }
    }

    const data = await response.json()
    const work = data.message

    // 게재 이벤트 감지 조건 판정
    const PUBLISHABLE_TYPES = ["journal-article", "proceedings-article", "book-chapter"]
    const hasPublishableType = PUBLISHABLE_TYPES.includes(work.type)
    const publishedPrint  = work["published-print"]?.["date-parts"]?.[0]
    const publishedOnline = work["published-online"]?.["date-parts"]?.[0]
    const hasPublishedDate = !!(publishedPrint || publishedOnline)

    // 세 조건 모두 충족 시에만 게재 이벤트로 판정
    const eventDetected = !!(work.DOI && hasPublishableType && hasPublishedDate)

    return {
      found: true,
      eventDetected,
      doi: work.DOI,
      title: work.title?.[0] ?? "Unknown",
      type: work.type ?? "unknown",
      hasPublishableType,
      hasPublishedDate,
      publishedDate: (publishedPrint || publishedOnline || []).join("-") || "Unknown",
      authors: (work.author ?? []).map(a => `${a.given ?? ""} ${a.family ?? ""}`.trim()),
      publisher: work.publisher ?? "Unknown",
      registeredDate: work.created?.["date-parts"]?.[0]?.join("-") ?? "Unknown",
      referenceCount: work["reference-count"] ?? 0,
      isReferencedByCount: work["is-referenced-by-count"] ?? 0
    }
  } catch (err) {
    clearTimeout(timeout)
    return { found: false, eventDetected: false, error: err.message, doi }
  }
}

/**
 * 오라클 이벤트를 생성한다.
 *
 * ※ 오라클 신뢰 모델에 대한 설계 주석
 *
 * 본 프로토타입의 오라클은 단일 주체(single oracle)로 구동되는
 * 개념 증명(PoC) 수준이다. 암호학적 무결성(cryptographic validity)은
 * did:key 기반 Ed25519 서명으로 확보되지만, 기관 신뢰(institutional
 * trust)는 본 실험의 범위에 포함되지 않는다.
 *
 * 실제 운영 환경에서는:
 *   - 다중 오라클 노드가 독립적으로 Crossref + ORCID + 학회 DB를
 *     교차 검증하고, 다수결 또는 합의로 이벤트를 확정하는
 *     탈중앙화 오라클 네트워크(DON) 구조가 요구된다.
 *   - 또는 학회·대학 등 신뢰 기관이 검증 노드로 참여하는
 *     연합(federated) 오라클 구조로 확장되어야 한다.
 *
 * decision 값의 의미:
 *   - "event_detected": Crossref에서 DOI 등록 + 출판 유형 +
 *     출판 일자가 모두 확인됨. 이는 "게재 이벤트 감지"이며,
 *     "학술적 품질 보증"과 구별된다.
 *   - "event_not_detected": 위 조건 미충족.
 */
function createOracleEvent({
  oracleDid,
  oraclePrivateKey,
  researcherDid,
  orcid,
  doi,
  crossrefMetadata,
  preimageHex,
  conditionHash
}) {
  // "published" 대신 "event_detected"/"event_not_detected"를 사용하여
  // Crossref가 학술 검증 기관이라는 오해를 방지한다.
  const decision = crossrefMetadata.eventDetected
    ? "event_detected"
    : "event_not_detected"

  const payload = {
    oracleDid,
    researcherDid,
    orcid,
    doi,
    decision,
    verifiedAt: new Date().toISOString(),
    dataSource: "Crossref API (https://api.crossref.org)",
    dataSourceRole: "DOI metadata registry (not a quality verification authority)",
    crossref: crossrefMetadata.found ? {
      title: crossrefMetadata.title,
      type: crossrefMetadata.type,
      hasPublishableType: crossrefMetadata.hasPublishableType,
      hasPublishedDate: crossrefMetadata.hasPublishedDate,
      publishedDate: crossrefMetadata.publishedDate,
      publisher: crossrefMetadata.publisher,
      citationCount: crossrefMetadata.isReferencedByCount
    } : null,
    fulfillmentHash: sha256Hex(Buffer.from(preimageHex, "hex")),
    xrplConditionHash: conditionHash
  }

  const proof = {
    type: "Ed25519Signature2020",
    created: new Date().toISOString(),
    proofPurpose: "assertionMethod",
    verificationMethod: `${oracleDid}#key-1`,
    jws: signJson(oraclePrivateKey, payload)
  }

  return { payload, proof }
}

/**
 * 오라클 이벤트의 서명을 did:key에서 복원한 공개키로 검증한다.
 */
function verifyOracleEventSignature(oracleEvent) {
  const oracleDid = oracleEvent.payload.oracleDid
  const oraclePublicKey = resolveDidKeyPublicKey(oracleDid)
  const ok = verifyJson(oraclePublicKey, oracleEvent.payload, oracleEvent.proof.jws)
  if (!ok) throw new Error("오라클 이벤트 서명 검증 실패")
  return true
}

// ============================================================
// 정책 검증
// ============================================================

function verifyPolicy({
  vc, expectedResearcherDid, expectedOrcid,
  oracleEvent, trustedOracleDid, expectedDoi, expectedDecision,
  conditionHash, preimageHex
}) {
  if (vc.credentialSubject.id !== expectedResearcherDid)
    throw new Error("VC subject DID 불일치")
  if (vc.credentialSubject.orcid !== expectedOrcid)
    throw new Error("VC ORCID 불일치")
  if (oracleEvent.payload.oracleDid !== trustedOracleDid)
    throw new Error("trustedOracleDid 불일치")
  if (oracleEvent.payload.researcherDid !== expectedResearcherDid)
    throw new Error("오라클 이벤트 researcherDid 불일치")
  if (oracleEvent.payload.orcid !== expectedOrcid)
    throw new Error("오라클 이벤트 ORCID 불일치")
  if (oracleEvent.payload.doi !== expectedDoi)
    throw new Error("오라클 이벤트 DOI 불일치")
  if (oracleEvent.payload.decision !== expectedDecision)
    throw new Error("오라클 이벤트 decision 불일치")

  const recalcHash = sha256Hex(Buffer.from(preimageHex, "hex"))
  if (recalcHash !== conditionHash)
    throw new Error("fulfillment → conditionHash 검증 실패")
  if (oracleEvent.payload.fulfillmentHash !== recalcHash)
    throw new Error("오라클 이벤트 fulfillmentHash 불일치")
  if (oracleEvent.payload.xrplConditionHash !== conditionHash)
    throw new Error("오라클 이벤트 xrplConditionHash 불일치")

  return true
}

// ============================================================
// 사전 검증 (시간 측정 포함)
// ============================================================

function performPrechecks({
  vc, expectedResearcherDid, expectedOrcid,
  oracleEvent, trustedOracleDid, expectedDoi, expectedDecision,
  conditionHash, preimageHex
}) {
  const nsToMs = ns => Number(ns) / 1_000_000

  const t0 = process.hrtime.bigint()
  verifyVcSignature(vc)

  const t1 = process.hrtime.bigint()
  verifyOracleEventSignature(oracleEvent)

  const t2 = process.hrtime.bigint()
  verifyPolicy({
    vc, expectedResearcherDid, expectedOrcid,
    oracleEvent, trustedOracleDid, expectedDoi, expectedDecision,
    conditionHash, preimageHex
  })
  const t3 = process.hrtime.bigint()

  return {
    vcVerifyMs:     nsToMs(t1 - t0),
    oracleVerifyMs: nsToMs(t2 - t1),
    policyVerifyMs: nsToMs(t3 - t2),
    precheckMs:     nsToMs(t3 - t0)
  }
}

// ============================================================
// 증거 파일 저장
// ============================================================

function saveEvidence(iteration, data) {
  const dir = path.join(EVIDENCE_DIR, `run_${String(iteration).padStart(3, "0")}`)
  fs.mkdirSync(dir, { recursive: true })

  if (data.institutionDidDoc)
    fs.writeFileSync(path.join(dir, "did_institution.json"), JSON.stringify(data.institutionDidDoc, null, 2))
  if (data.oracleDidDoc)
    fs.writeFileSync(path.join(dir, "did_oracle.json"), JSON.stringify(data.oracleDidDoc, null, 2))
  if (data.researcherDidDoc)
    fs.writeFileSync(path.join(dir, "did_researcher.json"), JSON.stringify(data.researcherDidDoc, null, 2))
  if (data.vc)
    fs.writeFileSync(path.join(dir, "vc_orcid_link.json"), JSON.stringify(data.vc, null, 2))
  if (data.oracleEvent)
    fs.writeFileSync(path.join(dir, "oracle_event.json"), JSON.stringify(data.oracleEvent, null, 2))
  if (data.crossrefMetadata)
    fs.writeFileSync(path.join(dir, "crossref_response.json"), JSON.stringify(data.crossrefMetadata, null, 2))
}

// ============================================================
// 통계 함수
// ============================================================

function mean(arr) { return arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0 }
function stddev(arr) { if(!arr.length)return 0; const m=mean(arr); return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length) }
function arrayMin(arr) { return arr.length ? Math.min(...arr) : 0 }
function arrayMax(arr) { return arr.length ? Math.max(...arr) : 0 }

function printStats(name, arr, digits=3) {
  console.log(`${name}`)
  console.log(`  mean : ${mean(arr).toFixed(digits)}`)
  console.log(`  std  : ${stddev(arr).toFixed(digits)}`)
  console.log(`  min  : ${arrayMin(arr).toFixed(digits)}`)
  console.log(`  max  : ${arrayMax(arr).toFixed(digits)}`)
}

// ============================================================
// XRPL 보조
// ============================================================

async function fundWalletWithRetry(client, maxRetries=FUND_WALLET_MAX_RETRIES) {
  let lastError
  for (let attempt=1; attempt<=maxRetries; attempt++) {
    try {
      const funded = await client.fundWallet()
      if (!funded?.wallet) throw new Error("fundWallet 응답에 wallet 필드 없음")
      return funded.wallet
    } catch(err) {
      lastError = err
      if (attempt < maxRetries) await sleep(RETRY_DELAY_MS)
    }
  }
  throw new Error(`fundWallet 실패 (${maxRetries}회 재시도 후): ${lastError?.message}`)
}

// ============================================================
// 단일 실험 실행
// ============================================================

async function runSingleExperiment(client, iteration) {
  const result = {
    iteration,
    success: false,
    crossrefApiMs: 0,
    vcVerifyMs: 0, oracleVerifyMs: 0, policyVerifyMs: 0, precheckMs: 0,
    createMs: 0, finishMs: 0, chainOnlyMs: 0, totalMs: 0,
    createFeeDrops: 0, finishFeeDrops: 0, totalFeeDrops: 0,
    usedDoi: "", crossrefFound: false,
    errorMessage: ""
  }

  const experimentStart = Date.now()

  try {
    // --- A. DID 키 쌍 생성 (did:key 방식) ---
    const institutionKeys = generateEd25519KeyPair()
    const oracleKeys      = generateEd25519KeyPair()
    const researcherKeys  = generateEd25519KeyPair()

    const { did: institutionDid, didDocument: institutionDidDoc } = createDidKeyDocument(institutionKeys.publicKey)
    const { did: oracleDid,      didDocument: oracleDidDoc }      = createDidKeyDocument(oracleKeys.publicKey)
    const { did: researcherDid,  didDocument: researcherDidDoc }  = createDidKeyDocument(researcherKeys.publicKey)

    // --- B. 실험용 식별자 ---
    const researcherOrcid = `0000-0002-1825-${String(9000 + iteration).padStart(4, "0")}`
    const articleDoi      = DOI_POOL[(iteration - 1) % DOI_POOL.length]
    result.usedDoi        = articleDoi

    // --- C. VC 발급 (기관이 연구자 ORCID 연동 증명) ---
    const vc = issueOrcidLinkVC({
      issuerDid:       institutionDid,
      issuerPrivateKey: institutionKeys.privateKey,
      subjectDid:      researcherDid,
      orcid:           researcherOrcid
    })

    // --- D. 지갑 생성 및 에스크로 조건 준비 ---
    const funder   = await fundWalletWithRetry(client)
    const receiver = await fundWalletWithRetry(client)

    const preimage      = crypto.randomBytes(32)
    const preimageHex   = preimage.toString("hex").toUpperCase()
    const conditionHash = sha256Hex(preimage)
    const conditionHex   = "A0258020" + conditionHash + "810120"
    const fulfillmentHex = "A0228020" + preimageHex

    // --- E. Crossref API 오라클 호출 (실제 HTTP) ---
    const apiStart = Date.now()
    const crossrefMetadata = await fetchCrossrefMetadata(articleDoi)
    result.crossrefApiMs = Date.now() - apiStart
    result.crossrefFound = crossrefMetadata.eventDetected

    const targetDecision = crossrefMetadata.eventDetected
      ? "event_detected"
      : "event_not_detected"

    // --- F. 오라클 이벤트 생성 (실제 Crossref 데이터 기반) ---
    const oracleEvent = createOracleEvent({
      oracleDid,
      oraclePrivateKey: oracleKeys.privateKey,
      researcherDid,
      orcid: researcherOrcid,
      doi: articleDoi,
      crossrefMetadata,
      preimageHex,
      conditionHash
    })

    // --- G. 사전 검증 (VC → 오라클 → 정책) ---
    const precheckTimes = performPrechecks({
      vc,
      expectedResearcherDid: researcherDid,
      expectedOrcid: researcherOrcid,
      oracleEvent,
      trustedOracleDid: oracleDid,
      expectedDoi: articleDoi,
      expectedDecision: targetDecision,
      conditionHash,
      preimageHex
    })

    result.vcVerifyMs     = precheckTimes.vcVerifyMs
    result.oracleVerifyMs = precheckTimes.oracleVerifyMs
    result.policyVerifyMs = precheckTimes.policyVerifyMs
    result.precheckMs     = precheckTimes.precheckMs

    // --- H. EscrowCreate ---
    const createStart = Date.now()
    const escrowCreateTx = {
      TransactionType: "EscrowCreate",
      Account:         funder.address,
      Destination:     receiver.address,
      Amount:          xrpl.xrpToDrops(ESCROW_AMOUNT_XRP),
      Condition:       conditionHex,
      CancelAfter:     xrpl.isoTimeToRippleTime(new Date(Date.now() + CANCEL_AFTER_MS))
    }
    const createResult = await client.submitAndWait(escrowCreateTx, { wallet: funder })
    result.createMs       = Date.now() - createStart
    result.createFeeDrops = Number(createResult?.result?.tx_json?.Fee ?? 0)
    const offerSequence   = createResult.result.tx_json.Sequence

    // --- I. EscrowFinish ---
    const finishStart = Date.now()
    const escrowFinishTx = {
      TransactionType: "EscrowFinish",
      Account:         receiver.address,
      Owner:           funder.address,
      OfferSequence:   offerSequence,
      Condition:       conditionHex,
      Fulfillment:     fulfillmentHex
    }
    const finishResult = await client.submitAndWait(escrowFinishTx, { wallet: receiver })
    result.finishMs       = Date.now() - finishStart
    result.finishFeeDrops = Number(finishResult?.result?.tx_json?.Fee ?? 0)

    // --- J. 파생 통계 ---
    result.chainOnlyMs   = result.createMs + result.finishMs
    result.totalFeeDrops = result.createFeeDrops + result.finishFeeDrops
    result.totalMs       = Date.now() - experimentStart
    result.success       = true

    // --- K. 증거 저장 ---
    saveEvidence(iteration, {
      institutionDidDoc, oracleDidDoc, researcherDidDoc,
      vc, oracleEvent, crossrefMetadata
    })

  } catch (err) {
    result.errorMessage  = err?.message ?? String(err)
    result.chainOnlyMs   = result.createMs + result.finishMs
    result.totalFeeDrops = result.createFeeDrops + result.finishFeeDrops
    result.totalMs       = Date.now() - experimentStart
  }

  return result
}

// ============================================================
// CSV 저장
// ============================================================

function saveResultsToCsv(results, summary, filePath) {
  const header =
    "iteration,success,usedDoi,eventDetected,crossrefApiMs," +
    "vcVerifyMs,oracleVerifyMs,policyVerifyMs,precheckMs," +
    "createMs,createFeeDrops,finishMs,finishFeeDrops," +
    "chainOnlyMs,totalFeeDrops,totalMs,errorMessage\n"

  let csv = header
  for (const r of results) {
    csv += [
      r.iteration, r.success, `"${r.usedDoi}"`, r.crossrefFound, r.crossrefApiMs,
      r.vcVerifyMs, r.oracleVerifyMs, r.policyVerifyMs, r.precheckMs,
      r.createMs, r.createFeeDrops, r.finishMs, r.finishFeeDrops,
      r.chainOnlyMs, r.totalFeeDrops, r.totalMs,
      `"${(r.errorMessage||"").replace(/"/g,'""')}"`
    ].join(",") + "\n"
  }

  csv += "\nmetric,mean,std,min,max\n"
  for (const [key, s] of Object.entries(summary)) {
    csv += `${key},${s.mean},${s.std},${s.min},${s.max}\n`
  }

  fs.writeFileSync(filePath, csv, "utf8")
}

function buildSummary(validResults) {
  const extract = key => validResults.map(r => r[key])
  const stat = arr => ({ mean:mean(arr), std:stddev(arr), min:arrayMin(arr), max:arrayMax(arr) })
  return {
    crossrefApi:    stat(extract("crossrefApiMs")),
    vcVerify:       stat(extract("vcVerifyMs")),
    oracleVerify:   stat(extract("oracleVerifyMs")),
    policyVerify:   stat(extract("policyVerifyMs")),
    precheck:       stat(extract("precheckMs")),
    create:         stat(extract("createMs")),
    finish:         stat(extract("finishMs")),
    chainOnly:      stat(extract("chainOnlyMs")),
    total:          stat(extract("totalMs")),
    createFeeDrops: stat(extract("createFeeDrops")),
    finishFeeDrops: stat(extract("finishFeeDrops")),
    totalFeeDrops:  stat(extract("totalFeeDrops"))
  }
}

// ============================================================
// 메인
// ============================================================

async function main() {
  // evidence 디렉토리 초기화
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

  const client = new xrpl.Client(XRPL_SERVER)

  try {
    await client.connect()
    console.log("XRPL 연결 완료")
    console.log(`TOTAL_RUNS=${TOTAL_RUNS} | DID: did:key | Oracle: Crossref API`)
    console.log(`DOI Pool: ${DOI_POOL.length}개 실제 논문 DOI 사용\n`)

    const allResults = []

    for (let i = 0; i < TOTAL_RUNS; i++) {
      const iteration = i + 1
      console.log(`[실행 ${iteration}/${TOTAL_RUNS}]`)

      const r = await runSingleExperiment(client, iteration)
      allResults.push(r)

      if (r.success) {
        console.log(
          `  성공 | DOI=${r.usedDoi} (event=${r.crossrefFound?"detected":"not_detected"}, api=${r.crossrefApiMs}ms)` +
          ` | vc=${r.vcVerifyMs.toFixed(3)}ms, oracle=${r.oracleVerifyMs.toFixed(3)}ms` +
          ` | create=${r.createMs}ms, finish=${r.finishMs}ms` +
          ` | fee=${r.totalFeeDrops} drops, total=${r.totalMs}ms`
        )
      } else {
        console.log(`  실패 | ${r.errorMessage}`)
      }

      await sleep(SLEEP_BETWEEN_RUNS_MS)
    }

    const validResults = allResults.filter(r => r.success)
    const failCount    = allResults.length - validResults.length

    console.log("\n==============================")
    console.log("실험 종료")
    console.log("==============================")
    console.log(`총 실행: ${TOTAL_RUNS} | 성공: ${validResults.length} | 실패: ${failCount}`)

    if (validResults.length === 0) {
      console.warn("경고: 성공한 실행이 없어 통계 산출 불가")
      return
    }

    const summary = buildSummary(validResults)

    console.log("\n[통계 요약 — 성공 건 기준]")
    printStats("Crossref API (ms)",  validResults.map(r => r.crossrefApiMs), 3)
    printStats("VC Verify (ms)",     validResults.map(r => r.vcVerifyMs), 3)
    printStats("Oracle Verify (ms)", validResults.map(r => r.oracleVerifyMs), 3)
    printStats("Policy Verify (ms)", validResults.map(r => r.policyVerifyMs), 3)
    printStats("Precheck (ms)",      validResults.map(r => r.precheckMs), 3)
    printStats("Create (ms)",        validResults.map(r => r.createMs), 3)
    printStats("Finish (ms)",        validResults.map(r => r.finishMs), 3)
    printStats("Chain Only (ms)",    validResults.map(r => r.chainOnlyMs), 3)
    printStats("Total (ms)",         validResults.map(r => r.totalMs), 3)
    printStats("Total Fee (drops)",  validResults.map(r => r.totalFeeDrops), 3)

    saveResultsToCsv(allResults, summary, OUTPUT_CSV)
    console.log(`\nCSV 저장 완료: ${OUTPUT_CSV}`)
    console.log(`증거 파일 저장 완료: ${EVIDENCE_DIR}/`)

  } catch (err) {
    console.error("\n치명적 오류:", err)
  } finally {
    await client.disconnect()
    console.log("\nXRPL 연결 종료")
  }
}

main()
