"use strict"

/**
 * ================================================================
 * Step B: 저장량 실측 검증 (수정판)
 * ================================================================
 * 수정: baseTx 별도 autofill 제거 → Sequence 충돌 해결
 *       memoTx 제출 후 Memo 필드만 제거하여 기본 크기 추정
 * ================================================================
 */

const xrpl   = require("xrpl")
const crypto = require("crypto")
const fs     = require("fs")

const XRPL_SERVER       = "wss://s.altnet.rippletest.net:51233"
const ITERATIONS        = 100
const ESCROW_AMOUNT_XRP = "1"
const FINISH_AFTER_SEC  = 30
const OUTPUT_CSV        = "storage_measurement_results.csv"
const OUTPUT_TXT        = "storage_measurement_summary.txt"
const S_EVENT_ESTIMATE  = 1024
const IPFS_CID_BYTES    = 59

const sleep = ms => new Promise(r => setTimeout(r, ms))

function sha256hex(data) {
    return crypto.createHash("sha256")
        .update(typeof data === "string" ? data : JSON.stringify(data))
        .digest("hex")
}

function measureTxSize(txBlob) { return txBlob.length / 2 }

async function main() {
    const lines = []
    const log = (...args) => { const s = args.join(" "); console.log(s); lines.push(s) }

    log("================================================================")
    log("Step B — 저장량 실측 검증")
    log(`실행시각: ${new Date().toLocaleString("ko-KR", { hour12: false })}`)
    log(`반복 횟수: ${ITERATIONS}회`)
    log("================================================================\n")

    const client = new xrpl.Client(XRPL_SERVER)
    await client.connect()
    log(`XRPL Testnet 연결 완료: ${XRPL_SERVER}`)
    const { wallet } = await client.fundWallet()
    log(`실험 지갑: ${wallet.address}\n`)

    const csvRows = ["iteration,base_tx_bytes,memo_tx_bytes,memo_overhead_bytes,memo_data_bytes,fee_drops"]
    const baseSizes = [], memoSizes = []

    for (let i = 1; i <= ITERATIONS; i++) {
        process.stdout.write(`\r  진행: ${i}/${ITERATIONS}`)

        const finishAfter = xrpl.isoTimeToRippleTime(new Date(Date.now() + FINISH_AFTER_SEC * 1000))

        // 이벤트 스키마 전체 구성 — s_event 설계와 동일하게
        // E = ⟨eid, type, t_occur, subject_did, target_doi, oracle_sig, payload_hash⟩ + cid_anchor
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

        try {
            // autofill 1회만 호출 — Memo에 이벤트 스키마 전체 포함
            const memoTx = {
                TransactionType: "EscrowCreate",
                Account:         wallet.address,
                Destination:     wallet.address,
                Amount:          xrpl.xrpToDrops(ESCROW_AMOUNT_XRP),
                FinishAfter:     finishAfter,
                Memos: [{ Memo: {
                    MemoType: Buffer.from("oracle/event-schema").toString("hex").toUpperCase(),
                    MemoData: Buffer.from(eventSchema).toString("hex").toUpperCase(),
                }}]
            }
            const prepared  = await client.autofill(memoTx)
            const signed    = wallet.sign(prepared)
            const memoBytes = measureTxSize(signed.tx_blob)
            await client.submitAndWait(signed.tx_blob)

            // 기본 크기: Memo 없는 동일 트랜잭션 재서명 (autofill 불필요 — 이미 채워진 prepared 재사용)
            const basePrep = { ...prepared }
            delete basePrep.Memos
            const baseSigned = wallet.sign(basePrep)
            const baseBytes  = measureTxSize(baseSigned.tx_blob)

            baseSizes.push(baseBytes)
            memoSizes.push(memoBytes)
            csvRows.push([i, baseBytes, memoBytes, memoBytes - baseBytes, memoDataBytes, parseInt(prepared.Fee||"12")].join(","))
        } catch(e) {
            log(`\n  [반복 ${i} 오류] ${e.message}`)
        }
        await sleep(500)
    }
    console.log()

    const avg = a => a.reduce((x,y)=>x+y,0)/a.length
    const std = a => { const m=avg(a); return Math.sqrt(a.map(v=>(v-m)**2).reduce((x,y)=>x+y,0)/a.length) }
    const avgBase = avg(baseSizes), avgMemo = avg(memoSizes)

    log("\n================================================================")
    log("[저장량 실측 결과 요약]")
    log("================================================================")
    log(`  측정 횟수                  : ${baseSizes.length}회`)
    log(`\n  [기본 EscrowCreate (Memo 없음)]`)
    log(`  평균 크기                  : ${avgBase.toFixed(1)} bytes`)
    log(`  표준편차                   : ${std(baseSizes).toFixed(1)} bytes`)
    log(`  최솟값 / 최댓값            : ${Math.min(...baseSizes)} / ${Math.max(...baseSizes)} bytes`)
    log(`\n  [Memo 포함 EscrowCreate (이벤트 스키마 전체)]`)
    log(`  평균 크기                  : ${avgMemo.toFixed(1)} bytes`)
    log(`  표준편차                   : ${std(memoSizes).toFixed(1)} bytes`)
    log(`  최솟값 / 최댓값            : ${Math.min(...memoSizes)} / ${Math.max(...memoSizes)} bytes`)
    log(`  Memo 오버헤드              : ${(avgMemo-avgBase).toFixed(1)} bytes`)
    log(`\n  [수식 추정값 대비 비교]`)
    log(`  s_event 추정값             : ${S_EVENT_ESTIMATE} bytes`)
    log(`  실측 평균 (Memo 포함)      : ${avgMemo.toFixed(1)} bytes`)
    log(`  차이 / 오차율              : ${(avgMemo-S_EVENT_ESTIMATE).toFixed(1)} bytes / ${((avgMemo-S_EVENT_ESTIMATE)/S_EVENT_ESTIMATE*100).toFixed(1)}%`)
    log(`\n  IPFS CID 실측값            : ${IPFS_CID_BYTES} bytes`)
    log(`  온체인 앵커링 해시         : 64 bytes (hex-encoded SHA-256)`)

    fs.writeFileSync(OUTPUT_CSV, csvRows.join("\n")+"\n", "utf8")
    fs.writeFileSync(OUTPUT_TXT, lines.join("\n")+"\n", "utf8")
    log(`\n저장 파일:\n  ${OUTPUT_CSV}\n  ${OUTPUT_TXT}`)

    await client.disconnect()
    log("\n=== Step B 완료 ===")
}

main().catch(e => { console.error("실험 오류:", e); process.exit(1) })
