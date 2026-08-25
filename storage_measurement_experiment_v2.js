"use strict"

/**
 * ================================================================
 * Step B-v2: 저장량 실측 검증 — TIME / CONDITION 양 모드
 * ================================================================
 * v1 대비 변경점
 *   1) CONDITION 모드(PREIMAGE-SHA-256) 측정 추가
 *      → v1은 FinishAfter만 사용해 TIME 모드만 측정했음
 *   2) 비교 기준을 s_event(1,024 B) → s_e + s_u(640 B)로 교체
 *      → v1의 "-37.9%"는 측정 대상이 아닌 5개 레코드 합산값과 비교한 결과
 *   3) 4개 변량을 동시 측정
 *      base_time / memo_time / base_cond / memo_cond
 *   4) Condition 필드 기여분(memo_cond - memo_time)을 직접 산출
 *
 * 측정 방식은 v1과 동일: 서명된 tx_blob의 바이트 길이(hex/2).
 * 크기는 필드 구성이 같으면 결정론적이므로 v1에서 SD=0이었다.
 * ================================================================
 */

const xrpl   = require("xrpl")
const crypto = require("crypto")
const fs     = require("fs")

const XRPL_SERVER       = "wss://s.altnet.rippletest.net:51233"
const ITERATIONS        = 100
const ESCROW_AMOUNT_XRP = "1"
const FINISH_AFTER_SEC  = 30
const CANCEL_AFTER_SEC  = 600
const OUTPUT_CSV        = "storage_measurement_results_v2.csv"
const OUTPUT_TXT        = "storage_measurement_summary_v2.txt"

// 설계값 (3.4.1절 [표 3-13])
const S_E_DESIGN        = 384    // ① 에스크로 트랜잭션
const S_U_DESIGN        = 256    // ⑤ AI 학습 활용 이벤트 레코드
const S_E_PLUS_U        = S_E_DESIGN + S_U_DESIGN   // 640 — 본 실험의 비교 기준
const S_EVENT_DESIGN    = 1024   // ①+⑤+⑥+⑦+⑨ (참고용, 측정 대상 아님)
const IPFS_CID_BYTES    = 59

// 온체인 제출 여부. false면 서명만 하고 크기만 측정한다.
// (크기는 제출과 무관하게 결정된다. Testnet 지갑 준비금이 부족하면 false 권장)
const SUBMIT_ONCHAIN    = true

const sleep = ms => new Promise(r => setTimeout(r, ms))

function sha256hex(data) {
    return crypto.createHash("sha256")
        .update(typeof data === "string" ? data : JSON.stringify(data))
        .digest("hex")
}

function measureTxSize(txBlob) { return txBlob.length / 2 }

/**
 * PREIMAGE-SHA-256 crypto-condition 생성 (4.1.1절 기술 방식과 동일)
 *   Condition   : A0 25 80 20 <32B hash> 81 01 20      → 39 bytes
 *   Fulfillment : A0 22 80 20 <32B preimage>           → 36 bytes
 */
function makeCryptoCondition() {
    const preimage = crypto.randomBytes(32)
    const hash     = crypto.createHash("sha256").update(preimage).digest()
    const condition   = ("A0258020" + hash.toString("hex") + "810120").toUpperCase()
    const fulfillment = ("A0228020" + preimage.toString("hex")).toUpperCase()
    return { condition, fulfillment }
}

async function main() {
    const lines = []
    const log = (...args) => { const s = args.join(" "); console.log(s); lines.push(s) }

    log("================================================================")
    log("Step B-v2 — 저장량 실측 검증 (TIME / CONDITION 양 모드)")
    log(`실행시각: ${new Date().toLocaleString("ko-KR", { hour12: false })}`)
    log(`반복 횟수: ${ITERATIONS}회 | 온체인 제출: ${SUBMIT_ONCHAIN ? "예" : "아니오(서명만)"}`)
    log("================================================================\n")

    const client = new xrpl.Client(XRPL_SERVER)
    await client.connect()
    log(`XRPL Testnet 연결 완료: ${XRPL_SERVER}`)
    const { wallet } = await client.fundWallet()
    log(`실험 지갑: ${wallet.address}\n`)

    const csvRows = ["iteration,base_time_bytes,memo_time_bytes,base_cond_bytes,memo_cond_bytes," +
                     "memo_overhead_time,memo_overhead_cond,condition_delta,memo_data_bytes,fee_drops"]
    const baseTime = [], memoTime = [], baseCond = [], memoCond = []

    for (let i = 1; i <= ITERATIONS; i++) {
        process.stdout.write(`\r  진행: ${i}/${ITERATIONS}`)

        const finishAfter = xrpl.isoTimeToRippleTime(new Date(Date.now() + FINISH_AFTER_SEC * 1000))
        const cancelAfter = xrpl.isoTimeToRippleTime(new Date(Date.now() + CANCEL_AFTER_SEC * 1000))
        const { condition } = makeCryptoCondition()

        // 이벤트 스키마 — v1과 완전히 동일하게 구성 (비교 가능성 유지)
        const mockDoi = `10.1234/mock.dissertation.${i.toString().padStart(4,"0")}`
        const mockDid = `did:xrpl:rMockAuthor${i.toString().padStart(8,"0")}`
        const mockCid = `bafkreimock${i.toString().padStart(6,"0")}`

        const eventSchema = JSON.stringify({
            eid:          `EVT-${Date.now()}-${i.toString().padStart(6,"0")}`,
            type:         "TYPE-1",
            t_occur:      new Date().toISOString(),
            subject_did:  mockDid,
            target_doi:   mockDoi,
            oracle_sig:   sha256hex(`oracle_sig_mock_${i}`).toUpperCase(),
            payload_hash: sha256hex(`payload_${mockDoi}_${i}`).toUpperCase(),
            cid_anchor:   sha256hex(mockCid).toUpperCase(),
        })
        const memoDataBytes = Buffer.from(eventSchema).length
        const memos = [{ Memo: {
            MemoType: Buffer.from("oracle/event-schema").toString("hex").toUpperCase(),
            MemoData: Buffer.from(eventSchema).toString("hex").toUpperCase(),
        }}]

        try {
            // ── CONDITION 모드 (논문의 핵심 설계) ────────────────────
            const condTx = {
                TransactionType: "EscrowCreate",
                Account:         wallet.address,
                Destination:     wallet.address,
                Amount:          xrpl.xrpToDrops(ESCROW_AMOUNT_XRP),
                Condition:       condition,
                CancelAfter:     cancelAfter,
                Memos:           memos,
            }
            const prepCond   = await client.autofill(condTx)
            const memoCondB  = measureTxSize(wallet.sign(prepCond).tx_blob)

            if (SUBMIT_ONCHAIN) await client.submitAndWait(wallet.sign(prepCond).tx_blob)

            // CONDITION 모드 base — Memo 제거 후 재서명 (제출하지 않음)
            const baseCondPrep = { ...prepCond }; delete baseCondPrep.Memos
            const baseCondB    = measureTxSize(wallet.sign(baseCondPrep).tx_blob)

            // ── TIME 모드 (v1 재현) ──────────────────────────────────
            // 동일 Sequence를 재사용해 서명만 수행. Condition·CancelAfter를 FinishAfter로 교체
            const timePrep = { ...prepCond }
            delete timePrep.Condition
            delete timePrep.CancelAfter
            timePrep.FinishAfter = finishAfter
            const memoTimeB = measureTxSize(wallet.sign(timePrep).tx_blob)

            const baseTimePrep = { ...timePrep }; delete baseTimePrep.Memos
            const baseTimeB    = measureTxSize(wallet.sign(baseTimePrep).tx_blob)

            baseTime.push(baseTimeB); memoTime.push(memoTimeB)
            baseCond.push(baseCondB); memoCond.push(memoCondB)

            csvRows.push([
                i, baseTimeB, memoTimeB, baseCondB, memoCondB,
                memoTimeB - baseTimeB, memoCondB - baseCondB,
                memoCondB - memoTimeB, memoDataBytes,
                parseInt(prepCond.Fee || "12")
            ].join(","))
        } catch(e) {
            log(`\n  [반복 ${i} 오류] ${e.message}`)
        }
        await sleep(500)
    }
    console.log()

    const avg = a => a.reduce((x,y)=>x+y,0)/a.length
    const sd  = a => { const m=avg(a); return Math.sqrt(a.map(v=>(v-m)**2).reduce((x,y)=>x+y,0)/a.length) }
    const f1  = x => x.toFixed(1)

    const aBT = avg(baseTime), aMT = avg(memoTime)
    const aBC = avg(baseCond), aMC = avg(memoCond)

    const report = (label, arr) => {
        log(`  ${label}`)
        log(`    평균 / SD        : ${f1(avg(arr))} / ${f1(sd(arr))} bytes`)
        log(`    최솟값 / 최댓값  : ${Math.min(...arr)} / ${Math.max(...arr)} bytes`)
    }

    log("\n================================================================")
    log("[저장량 실측 결과 요약 — 양 모드]")
    log("================================================================")
    log(`  측정 횟수 : ${baseTime.length}회\n`)
    report("TIME 모드 · Memo 없음 (base)", baseTime)
    report("TIME 모드 · Memo 포함", memoTime)
    report("CONDITION 모드 · Memo 없음 (base)", baseCond)
    report("CONDITION 모드 · Memo 포함", memoCond)

    log(`\n  [Memo 오버헤드]`)
    log(`    TIME      : ${f1(aMT-aBT)} bytes`)
    log(`    CONDITION : ${f1(aMC-aBC)} bytes`)

    log(`\n  [crypto-condition 필드 기여분]`)
    log(`    memo_cond - memo_time : ${f1(aMC-aMT)} bytes`)
    log(`    base_cond - base_time : ${f1(aBC-aBT)} bytes`)
    log(`    (이론값: Condition 39 B + 필드 ID 2 B + VL 1 B = 42 B)`)

    log(`\n  [설계값 대비 비교 — 비교 기준은 s_e + s_u]`)
    log(`    설계값 s_e + s_u          : ${S_E_PLUS_U} bytes  (= ${S_E_DESIGN} + ${S_U_DESIGN})`)
    log(`    실측 TIME (Memo 포함)     : ${f1(aMT)} bytes  → ${f1(aMT-S_E_PLUS_U)} bytes / ${f1((aMT-S_E_PLUS_U)/S_E_PLUS_U*100)}%`)
    log(`    실측 CONDITION (Memo 포함): ${f1(aMC)} bytes  → ${f1(aMC-S_E_PLUS_U)} bytes / ${f1((aMC-S_E_PLUS_U)/S_E_PLUS_U*100)}%`)
    log(`\n    ※ s_event(${S_EVENT_DESIGN} bytes)는 ①+⑤+⑥+⑦+⑨ 합산값이다.`)
    log(`       ⑥·⑦·⑨는 별도 시점 트랜잭션이므로 본 실험의 측정 대상이 아니다.`)
    log(`       따라서 비교 기준은 s_e + s_u = ${S_E_PLUS_U} bytes이며,`)
    log(`       추정 수식 입력 중 실측 확인 범위는 ${S_E_PLUS_U}/${S_EVENT_DESIGN} = ${(S_E_PLUS_U/S_EVENT_DESIGN*100).toFixed(1)}%다.`)

    log(`\n  [구성요소별 대조 — 합산 일치가 상쇄의 결과인지 확인]`)
    log(`    ① s_e  설계 ${S_E_DESIGN} vs 실측 base(CONDITION) ${f1(aBC)}  → ${f1(S_E_DESIGN-aBC)} bytes`)
    log(`    ⑤ s_u  설계 ${S_U_DESIGN} vs 실측 Memo 오버헤드 ${f1(aMC-aBC)}  → ${f1(S_U_DESIGN-(aMC-aBC))} bytes`)

    log(`\n  IPFS CID 실측값    : ${IPFS_CID_BYTES} bytes`)
    log(`  온체인 앵커링 해시 : 64 bytes (hex-encoded SHA-256)`)

    fs.writeFileSync(OUTPUT_CSV, csvRows.join("\n")+"\n", "utf8")
    fs.writeFileSync(OUTPUT_TXT, lines.join("\n")+"\n", "utf8")
    log(`\n저장 파일:\n  ${OUTPUT_CSV}\n  ${OUTPUT_TXT}`)

    await client.disconnect()
    log("\n=== Step B-v2 완료 ===")
}

main().catch(e => { console.error("실험 오류:", e); process.exit(1) })
