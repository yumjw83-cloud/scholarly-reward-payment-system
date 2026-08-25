"use strict"

/**
 * ============================================================
 * Condition 불일치 거부 검증 (보완 실험)
 * ============================================================
 * 목적:
 *   4.2.1절 "Condition 불일치 시 거부됨" 주장의 실측 근거를 확보한다.
 *   PREIMAGE-SHA-256 Condition이 설정된 에스크로에 대해
 *     (A) 형식은 유효하나 preimage가 불일치하는 Fulfillment 제출
 *         → tecCRYPTOCONDITION_ERROR 거부 기대
 *     (B) 동일 에스크로에 정상 Fulfillment 제출 (대조군)
 *         → tesSUCCESS 승인 기대
 *   (B)를 함께 수행하는 이유: (A)의 거부가 "에스크로 자체의 결함"이
 *   아니라 "조건 불일치" 때문임을 배제 논증으로 확정하기 위함이다.
 *
 * ⚠️ 기존 산출물 보호:
 *   본 스크립트는 xrpl_results_*.csv / *.txt 를 일절 읽거나 쓰지 않는다.
 *   출력은 condition_mismatch_results.{txt,csv} 로 분리된다.
 *   따라서 [표 4-11]·[표 4-12] 및 4.3.2절 통계값에 영향이 없다.
 *
 * 방법론 정합:
 *   Condition·Fulfillment 인코딩은 xrpl_escrow_experiment.js의
 *   runConditionMode()와 동일하게 IETF crypto-condition 명세에 따라
 *   16진 직접 구성한다 (Condition: "A0258020"+SHA256+"810120",
 *   Fulfillment: "A0228020"+preimage). [표 4-1] 참조.
 *
 * 실행 방법:
 *   node condition_mismatch_test.js
 *
 * 요구 사항:
 *   npm install xrpl        (API 키 불필요, Testnet Faucet 사용)
 * ============================================================
 */

const xrpl   = require("xrpl")
const crypto = require("crypto")
const fs     = require("fs")

// ============================================================
// 실험 설정
// ============================================================

/** 반복 횟수 (거부 판정은 결정론적이므로 소표본으로 충분) */
const ITERATIONS = 5

/** XRPL Testnet WebSocket 엔드포인트 ([표 4-1]과 동일) */
const WS_URL = "wss://s.altnet.rippletest.net:51233"

/** 에스크로 CancelAfter 여유 시간 (ms) */
const CANCEL_AFTER_MS = 24 * 60 * 60 * 1_000

/** 에스크로 금액 (XRP) */
const ESCROW_AMOUNT_XRP = "10"

// ============================================================
// 출력 파일명 — 기존 실험 산출물과 완전히 분리
// ============================================================
const TXT_FILE = "condition_mismatch_results.txt"
const CSV_FILE = "condition_mismatch_results.csv"

// ============================================================
// 유틸리티
// ============================================================

function nowString() {
  return new Date().toLocaleString("ko-KR")
}

function appendTxt(line) {
  console.log(line)
  fs.appendFileSync(TXT_FILE, line + "\n", "utf8")
}

function appendCsv(line) {
  fs.appendFileSync(CSV_FILE, line + "\n", "utf8")
}

function writeHeader() {
  const header =
    "================================================================\n" +
    "Condition 불일치 거부 검증 (4.2.1절 보완 실험)\n" +
    `실행시각: ${nowString()}\n` +
    `엔드포인트: ${WS_URL}\n` +
    `반복횟수: ${ITERATIONS} (케이스당)\n` +
    "================================================================\n"
  fs.writeFileSync(TXT_FILE, header, "utf8")
  fs.writeFileSync(
    CSV_FILE,
    "iteration,case,expected_result,actual_result,validated,tx_hash,elapsed_ms,fee_drops\n",
    "utf8"
  )
}

/**
 * PREIMAGE-SHA-256 Condition / Fulfillment 쌍을 생성한다.
 * IETF crypto-condition 명세(Thomas et al., 2018)에 따라 16진 직접 구성한다.
 */
function makeConditionPair() {
  const preimage      = crypto.randomBytes(32)
  const preimageHex   = preimage.toString("hex").toUpperCase()
  const conditionHash = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase()
  return {
    conditionHex:   "A0258020" + conditionHash + "810120",
    fulfillmentHex: "A0228020" + preimageHex,
  }
}

/**
 * 트랜잭션 제출 결과에서 엔진 결과 코드를 추출한다.
 * xrpl.js의 submitAndWait는 tec 계열(원장 포함·수수료 소모)에 대해
 * 정상 resolve 하고, tem·tef·ter 계열(원장 미포함)에 대해 throw 한다.
 * 두 경로를 모두 처리한다.
 */
async function submitAndCapture(client, tx, wallet) {
  const t0 = Date.now()
  try {
    const res = await client.submitAndWait(tx, { wallet })
    return {
      elapsedMs: Date.now() - t0,
      engineResult: res.result.meta?.TransactionResult ?? "UNKNOWN",
      hash: res.result.hash ?? "",
      fee: Number(res.result.tx_json?.Fee ?? 0),
      threw: false,
    }
  } catch (e) {
    // tem/tef/ter 계열 또는 네트워크 오류
    const m = /(?:^|\s)(te[mfr][A-Z_]+)/.exec(e.message || "")
    return {
      elapsedMs: Date.now() - t0,
      engineResult: m ? m[1] : `EXCEPTION: ${e.message}`,
      hash: "",
      fee: 0,
      threw: true,
    }
  }
}

// ============================================================
// 1회 실행
// ============================================================

/**
 * 에스크로 1건을 생성한 뒤
 *   (A) 불일치 Fulfillment 제출 → 거부 기대
 *   (B) 정상 Fulfillment 제출  → 승인 기대 (대조군)
 * 를 순차 수행한다.
 */
async function runOne(client, iteration) {
  const funder   = (await client.fundWallet()).wallet
  const receiver = (await client.fundWallet()).wallet

  // 정상 조건 쌍 + 불일치용 별도 조건 쌍
  const valid = makeConditionPair()
  const other = makeConditionPair()   // preimage가 다르므로 valid.condition을 충족하지 못함

  // --- EscrowCreate (정상 Condition) ---
  const createTx = {
    TransactionType: "EscrowCreate",
    Account:         funder.address,
    Destination:     receiver.address,
    Amount:          xrpl.xrpToDrops(ESCROW_AMOUNT_XRP),
    Condition:       valid.conditionHex,
    CancelAfter:     xrpl.isoTimeToRippleTime(new Date(Date.now() + CANCEL_AFTER_MS)),
  }
  const created = await client.submitAndWait(createTx, { wallet: funder })
  if (created.result.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`EscrowCreate 실패: ${created.result.meta?.TransactionResult}`)
  }
  const offerSequence = created.result.tx_json.Sequence

  appendTxt(`\n[${iteration}] EscrowCreate 성공  Seq=${offerSequence}  Hash=${created.result.hash}`)

  // --- (A) 불일치 Fulfillment 제출 → tecCRYPTOCONDITION_ERROR 기대 ---
  // 형식은 유효한 PREIMAGE-SHA-256 Fulfillment이나 preimage가 다르다.
  // (형식 자체를 깨뜨리면 temMALFORMED로 원장 진입 전 거부되어
  //  '조건 검증에 의한 거부'를 입증하지 못하므로 형식은 유지한다.)
  const mismatchTx = {
    TransactionType: "EscrowFinish",
    Account:         receiver.address,
    Owner:           funder.address,
    OfferSequence:   offerSequence,
    Condition:       valid.conditionHex,
    Fulfillment:     other.fulfillmentHex,   // ← 불일치
  }
  const a = await submitAndCapture(client, mismatchTx, receiver)
  const aPass = a.engineResult === "tecCRYPTOCONDITION_ERROR"
  appendTxt(
    `[${iteration}] (A) 불일치 Fulfillment | 기대=tecCRYPTOCONDITION_ERROR ` +
    `실제=${a.engineResult} ${aPass ? "✅" : "❌"} (${a.elapsedMs}ms, Fee=${a.fee} drops)`
  )
  appendCsv(
    `${iteration},MISMATCH,tecCRYPTOCONDITION_ERROR,${a.engineResult},` +
    `${aPass},${a.hash},${a.elapsedMs},${a.fee}`
  )

  // --- (B) 정상 Fulfillment 제출 → tesSUCCESS 기대 (대조군) ---
  // 동일 에스크로가 여전히 유효함을 보여, (A)의 거부 원인이
  // 에스크로 결함이 아니라 조건 불일치임을 확정한다.
  const validTx = {
    TransactionType: "EscrowFinish",
    Account:         receiver.address,
    Owner:           funder.address,
    OfferSequence:   offerSequence,
    Condition:       valid.conditionHex,
    Fulfillment:     valid.fulfillmentHex,
  }
  const b = await submitAndCapture(client, validTx, receiver)
  const bPass = b.engineResult === "tesSUCCESS"
  appendTxt(
    `[${iteration}] (B) 정상 Fulfillment   | 기대=tesSUCCESS ` +
    `실제=${b.engineResult} ${bPass ? "✅" : "❌"} (${b.elapsedMs}ms, Fee=${b.fee} drops)`
  )
  appendCsv(
    `${iteration},CONTROL,tesSUCCESS,${b.engineResult},` +
    `${bPass},${b.hash},${b.elapsedMs},${b.fee}`
  )

  return { aPass, bPass }
}

// ============================================================
// 메인
// ============================================================

async function main() {
  writeHeader()

  const client = new xrpl.Client(WS_URL)
  await client.connect()
  appendTxt(`XRPL Testnet 연결 완료: ${WS_URL}`)

  let aOk = 0, bOk = 0, errors = 0

  try {
    for (let i = 1; i <= ITERATIONS; i++) {
      try {
        const r = await runOne(client, i)
        if (r.aPass) aOk++
        if (r.bPass) bOk++
      } catch (e) {
        errors++
        appendTxt(`[${i}] ❌ 오류: ${e.message}`)
        appendCsv(`${i},ERROR,,${e.message.replace(/,/g, ";")},false,,0,0`)
      }
    }
  } finally {
    await client.disconnect()
  }

  const allPass = aOk === ITERATIONS && bOk === ITERATIONS && errors === 0

  appendTxt("\n================================================================")
  appendTxt("[실험 결과 요약]")
  appendTxt("================================================================")
  appendTxt(`  (A) 불일치 Fulfillment 거부 : ${aOk}/${ITERATIONS} tecCRYPTOCONDITION_ERROR`)
  appendTxt(`  (B) 정상 Fulfillment 승인   : ${bOk}/${ITERATIONS} tesSUCCESS`)
  appendTxt(`  오류                        : ${errors}건`)
  appendTxt(`\n  종합 판정: ${allPass ? "전 케이스 통과 ✅" : "일부 실패 ❌"}`)
  appendTxt("\n  4.2.1절 'Condition 불일치 시 거부' 실측 근거 확보")
  appendTxt(`\n  출력: ${TXT_FILE}, ${CSV_FILE}`)

  process.exit(allPass ? 0 : 1)
}

main().catch(e => {
  console.error("치명적 오류:", e)
  process.exit(1)
})
