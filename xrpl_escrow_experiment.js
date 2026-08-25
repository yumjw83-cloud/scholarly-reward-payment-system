/**
 * ============================================================
 * XRPL Escrow 성능 측정 실험 코드 v2
 * ============================================================
 *
 * 실험 목적:
 *   XRPL Testnet에서 EscrowCreate / EscrowFinish / EscrowCancel
 *   트랜잭션의 처리 시간(ms) 및 수수료(drops)를 반복 측정하여
 *   통계를 산출한다.
 *
 * 지원 모드:
 *   - "time"      : FinishAfter 기반 시간 조건 에스크로
 *   - "condition" : PREIMAGE-SHA-256 암호 조건 에스크로
 *   - "cancel"    : CancelAfter 기반 만료 취소 에스크로
 *                   (EscrowCreate + CancelAfter 대기 + EscrowCancel)
 *
 * 측정 항목:
 *   - EscrowCreate 처리 시간 (ms) / 수수료 (drops)
 *   - EscrowFinish 또는 EscrowCancel 처리 시간 (ms) / 수수료 (drops)
 *   - 평균(mean) / 표준편차(std_dev) / min / max / p95
 *
 * 실험 조건:
 *   - 매 반복마다 새 지갑 쌍(funder, receiver) 생성
 *   - warm-up 없음
 *   - 결과를 .txt 및 .csv 파일로 저장
 *
 * Cancel 모드 설계:
 *   EscrowCreate 시 Condition(PREIMAGE-SHA-256) + CancelAfter(20초 후) 설정.
 *   Fulfillment를 제출하지 않으므로 EscrowFinish 불가.
 *   CancelAfter 도과 후 EscrowCancel 실행 → 자산 반환 경로 측정.
 *   XRPL 프로토콜 요건(Condition 또는 FinishAfter 필수) 충족.
 *
 * 주의:
 *   XRPL Altnet Testnet을 사용하므로 네트워크 응답 시간은
 *   실제 Mainnet과 다를 수 있다.
 *
 * 의존 패키지:
 *   xrpl (npm install xrpl)
 *
 * 실행 방법:
 *   node index_fixed.js
 * ============================================================
 */

"use strict"

const xrpl   = require("xrpl")
const crypto = require("crypto")
const fs     = require("fs")

// ============================================================
// 실험 설정
// ============================================================

/** 반복 횟수 */
const ITERATIONS = 100

/**
 * 실행 모드: "time" | "condition" | "cancel"
 * 실험 시 이 값만 변경하여 재실행한다.
 */
const MODE = "cancel"

/** XRPL Testnet WebSocket 엔드포인트 */
const WS_URL = "wss://s.altnet.rippletest.net:51233"

// --- time 모드 설정 ---
/** FinishAfter까지 잠금 시간 (ms) */
const TIME_LOCK_MS = 5_000
/** FinishAfter 만료 후 EscrowFinish 실행 전 여유 대기 (ms) */
const TIME_WAIT_BUFFER_MS = 6_000

// --- condition 모드 설정 ---
/** condition 모드 에스크로의 CancelAfter 여유 시간 (ms) */
const CONDITION_CANCEL_AFTER_MS = 24 * 60 * 60 * 1_000

// --- cancel 모드 설정 ---
/**
 * cancel 모드 설계:
 *   XRPL 규칙: EscrowCreate에 Condition 또는 FinishAfter 중 하나 필수.
 *              FinishAfter + CancelAfter 동시 설정 시 CancelAfter > FinishAfter 필수.
 *
 *   채택 방식: Condition(PREIMAGE-SHA-256) + CancelAfter 설정.
 *              Fulfillment를 제출하지 않으므로 EscrowFinish 불가.
 *              CancelAfter 도과 후 EscrowCancel만 가능.
 */
const CANCEL_EXPIRE_MS     = 20_000   // CancelAfter: 20초 후 취소 가능
const CANCEL_WAIT_BUFFER_MS = 22_000  // 22초 대기 후 EscrowCancel 실행

// ============================================================
// 출력 파일명
// ============================================================
const TXT_FILE = `xrpl_results_${MODE}.txt`
const CSV_FILE = `xrpl_results_${MODE}.csv`

// ============================================================
// 유틸리티 함수
// ============================================================

/** 배열의 산술 평균을 반환한다. */
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

/** 배열의 표준편차를 반환한다. */
function stdDev(arr) {
  const m = mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
}

/** 배열의 p번째 백분위수를 반환한다 (선형 보간). */
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx    = (p / 100) * (sorted.length - 1)
  const lo     = Math.floor(idx)
  const hi     = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** 배열의 최솟값을 반환한다. */
function arrayMin(arr) { return Math.min(...arr) }

/** 배열의 최댓값을 반환한다. */
function arrayMax(arr) { return Math.max(...arr) }

/** 현재 시각을 한국 로캘 문자열로 반환한다. */
function nowString() {
  return new Date().toLocaleString("ko-KR")
}

// ============================================================
// 파일 I/O
// ============================================================

function writeHeader() {
  const secondOp = MODE === "cancel" ? "cancel" : "finish"

  const header =
    `XRPL Escrow 성능 측정 결과\n` +
    `실행시각  : ${nowString()}\n` +
    `모드      : ${MODE}\n` +
    `반복횟수  : ${ITERATIONS}\n` +
    `네트워크  : ${WS_URL}\n\n`

  fs.writeFileSync(TXT_FILE, header, "utf8")
  fs.writeFileSync(
    CSV_FILE,
    `iteration,mode,create_ms,create_fee_drops,` +
    `${secondOp}_ms,${secondOp}_fee_drops,` +
    `create_hash,${secondOp}_hash\n`,
    "utf8"
  )
}

function appendTxt(line) { fs.appendFileSync(TXT_FILE, line + "\n", "utf8") }
function appendCsv(line) { fs.appendFileSync(CSV_FILE, line + "\n", "utf8") }

// ============================================================
// 통계 출력 헬퍼
// ============================================================

function printStats(label, msArr, feeArr) {
  appendTxt(`--- ${label} ---`)
  appendTxt(`  평균    (ms)   : ${mean(msArr).toFixed(3)}`)
  appendTxt(`  표준편차(ms)   : ${stdDev(msArr).toFixed(3)}`)
  appendTxt(`  최솟값  (ms)   : ${arrayMin(msArr)}`)
  appendTxt(`  최댓값  (ms)   : ${arrayMax(msArr)}`)
  appendTxt(`  p95     (ms)   : ${percentile(msArr, 95).toFixed(3)}`)
  appendTxt(`  평균수수료(drops): ${mean(feeArr).toFixed(3)}`)
}

// ============================================================
// 실험 실행: 시간(FinishAfter) 조건 모드
// ============================================================

async function runTimeMode(client, iteration) {
  const funder   = (await client.fundWallet()).wallet
  const receiver = (await client.fundWallet()).wallet

  // EscrowCreate
  const createStart    = Date.now()
  const escrowCreateTx = {
    TransactionType: "EscrowCreate",
    Account:         funder.address,
    Destination:     receiver.address,
    Amount:          xrpl.xrpToDrops("10"),
    FinishAfter:     xrpl.isoTimeToRippleTime(new Date(Date.now() + TIME_LOCK_MS))
  }
  const createResult = await client.submitAndWait(escrowCreateTx, { wallet: funder })
  const createMs     = Date.now() - createStart
  const createTx     = createResult.result.tx_json
  const createFee    = Number(createTx.Fee)
  const createHash   = createResult.result.hash

  // FinishAfter 만료 대기
  await new Promise(r => setTimeout(r, TIME_WAIT_BUFFER_MS))

  // EscrowFinish
  const finishStart    = Date.now()
  const escrowFinishTx = {
    TransactionType: "EscrowFinish",
    Account:         receiver.address,
    Owner:           funder.address,
    OfferSequence:   createTx.Sequence
  }
  const finishResult = await client.submitAndWait(escrowFinishTx, { wallet: receiver })
  const finishMs     = Date.now() - finishStart
  const finishTx     = finishResult.result.tx_json
  const finishFee    = Number(finishTx.Fee)
  const finishHash   = finishResult.result.hash

  appendTxt(
    `[${iteration}] TIME | ` +
    `Create=${createMs}ms Fee=${createFee} drops Hash=${createHash} | ` +
    `Finish=${finishMs}ms Fee=${finishFee} drops Hash=${finishHash}`
  )
  appendCsv(`${iteration},time,${createMs},${createFee},${finishMs},${finishFee},${createHash},${finishHash}`)

  return { createMs, createFee, secondMs: finishMs, secondFee: finishFee }
}

// ============================================================
// 실험 실행: 암호 조건(PREIMAGE-SHA-256) 모드
// ============================================================

async function runConditionMode(client, iteration) {
  const funder   = (await client.fundWallet()).wallet
  const receiver = (await client.fundWallet()).wallet

  const preimage       = crypto.randomBytes(32)
  const preimageHex    = preimage.toString("hex").toUpperCase()
  const conditionHash  = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase()
  const conditionHex   = "A0258020" + conditionHash + "810120"
  const fulfillmentHex = "A0228020" + preimageHex

  // EscrowCreate
  const createStart    = Date.now()
  const escrowCreateTx = {
    TransactionType: "EscrowCreate",
    Account:         funder.address,
    Destination:     receiver.address,
    Amount:          xrpl.xrpToDrops("10"),
    Condition:       conditionHex,
    CancelAfter:     xrpl.isoTimeToRippleTime(new Date(Date.now() + CONDITION_CANCEL_AFTER_MS))
  }
  const createResult = await client.submitAndWait(escrowCreateTx, { wallet: funder })
  const createMs     = Date.now() - createStart
  const createTx     = createResult.result.tx_json
  const createFee    = Number(createTx.Fee)
  const createHash   = createResult.result.hash

  // EscrowFinish (조건 충족)
  const finishStart    = Date.now()
  const escrowFinishTx = {
    TransactionType: "EscrowFinish",
    Account:         receiver.address,
    Owner:           funder.address,
    OfferSequence:   createTx.Sequence,
    Condition:       conditionHex,
    Fulfillment:     fulfillmentHex
  }
  const finishResult = await client.submitAndWait(escrowFinishTx, { wallet: receiver })
  const finishMs     = Date.now() - finishStart
  const finishTx     = finishResult.result.tx_json
  const finishFee    = Number(finishTx.Fee)
  const finishHash   = finishResult.result.hash

  appendTxt(
    `[${iteration}] CONDITION | ` +
    `Create=${createMs}ms Fee=${createFee} drops Hash=${createHash} | ` +
    `Finish=${finishMs}ms Fee=${finishFee} drops Hash=${finishHash}`
  )
  appendCsv(`${iteration},condition,${createMs},${createFee},${finishMs},${finishFee},${createHash},${finishHash}`)

  return { createMs, createFee, secondMs: finishMs, secondFee: finishFee }
}

// ============================================================
// 실험 실행: 만료 취소(CancelAfter) 모드  ← 수정된 부분
// ============================================================

/**
 * Condition + CancelAfter 기반 에스크로를 1회 실행하여 측정 결과를 반환한다.
 *
 * 설계 근거:
 *   XRPL EscrowCreate는 Condition 또는 FinishAfter 중 하나가 필수이다.
 *   본 모드는 Condition(PREIMAGE-SHA-256)을 설정하되 Fulfillment를
 *   제출하지 않으므로 EscrowFinish가 불가능하다.
 *   CancelAfter(20초) 도과 후 EscrowCancel을 실행하여 자산 반환 경로를 측정한다.
 *   3.2.4절 설계의 EscrowCancel 실행 가능성을 검증한다.
 */
async function runCancelMode(client, iteration) {
  const funder   = (await client.fundWallet()).wallet
  const receiver = (await client.fundWallet()).wallet

  // Condition 생성 — Fulfillment는 보관만 하고 제출하지 않음
  const preimage      = crypto.randomBytes(32)
  const conditionHash = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase()
  const conditionHex  = "A0258020" + conditionHash + "810120"

  const cancelAfterTs = xrpl.isoTimeToRippleTime(new Date(Date.now() + CANCEL_EXPIRE_MS))

  // EscrowCreate: Condition + CancelAfter만 설정
  const createStart    = Date.now()
  const escrowCreateTx = {
    TransactionType: "EscrowCreate",
    Account:         funder.address,
    Destination:     receiver.address,
    Amount:          xrpl.xrpToDrops("10"),
    Condition:       conditionHex,  // Fulfillment 미제출 → EscrowFinish 불가
    CancelAfter:     cancelAfterTs  // 20초 후 취소 가능
  }
  const createResult = await client.submitAndWait(escrowCreateTx, { wallet: funder })
  const createMs     = Date.now() - createStart
  const createTx     = createResult.result.tx_json
  const createFee    = Number(createTx.Fee)
  const createHash   = createResult.result.hash

  // CancelAfter 도과까지 대기
  await new Promise(r => setTimeout(r, CANCEL_WAIT_BUFFER_MS))

  // EscrowCancel: funder가 만료된 에스크로 취소
  const cancelStart    = Date.now()
  const escrowCancelTx = {
    TransactionType: "EscrowCancel",
    Account:         funder.address,
    Owner:           funder.address,
    OfferSequence:   createTx.Sequence
  }
  const cancelResult = await client.submitAndWait(escrowCancelTx, { wallet: funder })
  const cancelMs     = Date.now() - cancelStart
  const cancelTx     = cancelResult.result.tx_json
  const cancelFee    = Number(cancelTx.Fee)
  const cancelHash   = cancelResult.result.hash

  appendTxt(
    `[${iteration}] CANCEL | ` +
    `Create=${createMs}ms Fee=${createFee} drops Hash=${createHash} | ` +
    `Cancel=${cancelMs}ms Fee=${cancelFee} drops Hash=${cancelHash}`
  )
  appendCsv(`${iteration},cancel,${createMs},${createFee},${cancelMs},${cancelFee},${createHash},${cancelHash}`)

  return { createMs, createFee, secondMs: cancelMs, secondFee: cancelFee }
}

// ============================================================
// 메인 실행부
// ============================================================

async function main() {
  const client = new xrpl.Client(WS_URL)

  const createMsArr  = []
  const createFeeArr = []
  const secondMsArr  = []
  const secondFeeArr = []

  writeHeader()

  try {
    await client.connect()
    appendTxt(`XRPL Testnet 연결 완료: ${WS_URL}`)
    console.log("XRPL Testnet 연결 완료")

    for (let i = 1; i <= ITERATIONS; i++) {
      console.log(`실행 ${i}/${ITERATIONS} 시작...`)

      let result

      try {
        if      (MODE === "time")      result = await runTimeMode(client, i)
        else if (MODE === "condition") result = await runConditionMode(client, i)
        else if (MODE === "cancel")    result = await runCancelMode(client, i)
        else throw new Error(`지원하지 않는 MODE 값: ${MODE}`)
      } catch (iterErr) {
        const msg = `[${i}] 오류 발생 (건너뜀): ${iterErr.message}`
        appendTxt(msg)
        console.warn(msg)
        continue
      }

      createMsArr.push(result.createMs)
      createFeeArr.push(result.createFee)
      secondMsArr.push(result.secondMs)
      secondFeeArr.push(result.secondFee)

      console.log(`실행 ${i}/${ITERATIONS} 완료`)
    }

    // 통계 산출
    const n = createMsArr.length
    if (n < 2) {
      const warn = `경고: 성공 횟수 부족으로 통계 산출 불가 (최소 2회 필요)`
      appendTxt(warn)
      console.warn(warn)
      return
    }

    const secondLabel = MODE === "cancel" ? "EscrowCancel" : "EscrowFinish"

    appendTxt(`\n===== 요약 통계 (성공 ${n}회 기준) =====`)
    printStats("EscrowCreate", createMsArr, createFeeArr)
    printStats(secondLabel,    secondMsArr, secondFeeArr)

    // CSV 요약 행
    const secondOp = MODE === "cancel" ? "cancel" : "finish"
    appendCsv(`AVERAGE,${MODE},${mean(createMsArr).toFixed(3)},${mean(createFeeArr).toFixed(3)},${mean(secondMsArr).toFixed(3)},${mean(secondFeeArr).toFixed(3)},,`)
    appendCsv(`STDDEV,${MODE},${stdDev(createMsArr).toFixed(3)},,${stdDev(secondMsArr).toFixed(3)},,,`)
    appendCsv(`MIN,${MODE},${arrayMin(createMsArr)},${arrayMin(createFeeArr)},${arrayMin(secondMsArr)},${arrayMin(secondFeeArr)},,`)
    appendCsv(`MAX,${MODE},${arrayMax(createMsArr)},${arrayMax(createFeeArr)},${arrayMax(secondMsArr)},${arrayMax(secondFeeArr)},,`)
    appendCsv(`P95,${MODE},${percentile(createMsArr,95).toFixed(3)},,${percentile(secondMsArr,95).toFixed(3)},,,`)

    console.log(`\n저장 완료: ${TXT_FILE}, ${CSV_FILE}`)

  } catch (error) {
    appendTxt(`치명적 오류 발생: ${error.message}`)
    console.error("오류 발생:", error)
  } finally {
    await client.disconnect()
    console.log("연결 종료")
  }
}

main()
