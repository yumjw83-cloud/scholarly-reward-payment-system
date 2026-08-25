"use strict"

/**
 * ================================================================
 * Step A: 동시 부하 시뮬레이션 실험
 * ================================================================
 *
 * 목적:
 *   동시 트랜잭션 수(50, 70, 100)에 따른 EscrowCreate 지연시간
 *   변화를 측정한다. 4.3.4절 부하 한계 추정의 수식 기반 결과를
 *   실측값으로 보완한다.
 *
 * 실험 설계:
 *   - 동시 제출 수: CONCURRENCY_LEVELS = [1, 5, 10, 20]
 *   - 각 조건당 반복: REPEATS_PER_LEVEL = 10
 *   - 측정 대상: EscrowCreate 배치 완료까지 소요 시간
 *     (배치 내 개별 트랜잭션 지연시간 + 배치 전체 지연시간)
 *   - 모드: Time 모드 (FinishAfter 5초)
 *     → Condition 모드는 수수료가 높아 부하 테스트에 부적합
 *
 * 출력:
 *   concurrent_load_results.csv  — 수치 데이터
 *   concurrent_load_results.txt  — 상세 로그
 *
 * 실행:
 *   node concurrent_load_experiment.js
 * ================================================================
 */

const xrpl   = require("xrpl")
const crypto = require("crypto")
const fs     = require("fs")

// ================================================================
// 실험 설정
// ================================================================

const XRPL_SERVER         = "wss://s.altnet.rippletest.net:51233"
const CONCURRENCY_LEVELS  = [50, 70, 100]   // 동시 제출 수
const REPEATS_PER_LEVEL   = 10                // 조건당 반복 횟수
const ESCROW_AMOUNT_XRP   = "1"
const FINISH_AFTER_SEC    = 5                 // Time 모드 잠금 시간
const OUTPUT_CSV          = "concurrent_load_results_ext.csv"
const OUTPUT_TXT          = "concurrent_load_results_ext.txt"

// ================================================================
// 유틸리티
// ================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms))

function nowMs() {
    return performance.now()
}

function isoNow() {
    return new Date().toLocaleString("ko-KR", { hour12: false })
}

function pad(s, n = 20) {
    return String(s).padEnd(n)
}

// ================================================================
// 단일 EscrowCreate 실행 (비동기)
// ================================================================

async function runSingleEscrowCreate(client, wallet) {
    const finishAfter = xrpl.isoTimeToRippleTime(
        new Date(Date.now() + FINISH_AFTER_SEC * 1000)
    )

    const tx = {
        TransactionType: "EscrowCreate",
        Account:         wallet.address,
        Destination:     wallet.address,
        Amount:          xrpl.xrpToDrops(ESCROW_AMOUNT_XRP),
        FinishAfter:     finishAfter,
    }

    const t0 = nowMs()
    const prepared = await client.autofill(tx)
    const signed   = wallet.sign(prepared)
    const result   = await client.submitAndWait(signed.tx_blob)
    const elapsed  = nowMs() - t0

    const fee = parseInt(prepared.Fee || "12")
    const seq = prepared.Sequence

    return { elapsed, fee, seq, hash: result.result.hash }
}

// ================================================================
// 배치 실행: concurrency개 동시 제출
// ================================================================

async function runBatch(client, wallet, concurrency) {
    const t0 = nowMs()

    // concurrency개 트랜잭션을 동시에 제출
    const tasks = Array.from({ length: concurrency }, () =>
        runSingleEscrowCreate(client, wallet)
    )
    const results = await Promise.allSettled(tasks)

    const batchElapsed = nowMs() - t0

    const successes = results.filter(r => r.status === "fulfilled")
    const failures  = results.filter(r => r.status === "rejected")

    const indivMs = successes.map(r => r.value.elapsed)
    const avgIndiv = indivMs.length > 0
        ? indivMs.reduce((a, b) => a + b, 0) / indivMs.length
        : 0
    const maxIndiv = indivMs.length > 0 ? Math.max(...indivMs) : 0
    const minIndiv = indivMs.length > 0 ? Math.min(...indivMs) : 0

    return {
        concurrency,
        batchElapsed,   // 배치 전체 완료까지 소요 시간
        avgIndiv,       // 개별 트랜잭션 평균 지연시간
        minIndiv,
        maxIndiv,
        successCount: successes.length,
        failCount:    failures.length,
        errors: failures.map(r => r.reason?.message || "unknown"),
    }
}

// ================================================================
// 메인 실험
// ================================================================

// ============================================================
// 통계 함수 — 논문 [표 4-14]와 동일한 정의를 사용한다.
//   std : 표본 표준편차(n-1로 나눔). 10회 반복은 모집단이 아니라 표본이다.
//   p95 : 선형보간 백분위수. 소표본에서 최근접순위법은 최댓값에 고착된다.
// ============================================================
function sampleStdDev(arr) {
    if (arr.length < 2) return 0
    const m = arr.reduce((a, b) => a + b, 0) / arr.length
    return Math.sqrt(
        arr.map(v => (v - m) ** 2).reduce((a, b) => a + b, 0) / (arr.length - 1)
    )
}

function percentileLinear(arr, p) {
    const s = [...arr].sort((a, b) => a - b)
    const idx = (p / 100) * (s.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.min(lo + 1, s.length - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

async function main() {
    const lines = []
    const log = (...args) => {
        const s = args.join(" ")
        console.log(s)
        lines.push(s)
    }

    log("================================================================")
    log("Step A — 동시 부하 시뮬레이션 실험")
    log(`실행시각: ${isoNow()}`)
    log(`동시 제출 수: ${CONCURRENCY_LEVELS.join(", ")}`)
    log(`조건당 반복: ${REPEATS_PER_LEVEL}회`)
    log("================================================================")

    const client = new xrpl.Client(XRPL_SERVER)
    await client.connect()
    log(`XRPL Testnet 연결 완료: ${XRPL_SERVER}\n`)

    // 지갑 생성
    const { wallet } = await client.fundWallet()
    log(`실험 지갑: ${wallet.address}\n`)

    // CSV 헤더
    const csvRows = []
    csvRows.push([
        "concurrency",
        "repeat",
        "batch_elapsed_ms",
        "avg_indiv_ms",
        "min_indiv_ms",
        "max_indiv_ms",
        "success_count",
        "fail_count",
    ].join(","))

    // 결과 집계용
    const summary = {}  // concurrency → 배치 elapsed 목록

    for (const concurrency of CONCURRENCY_LEVELS) {
        log(`${"=".repeat(64)}`)
        log(`동시 제출 수: ${concurrency}`)
        log(`${"=".repeat(64)}`)

        summary[concurrency] = []

        for (let rep = 1; rep <= REPEATS_PER_LEVEL; rep++) {
            log(`  반복 ${rep}/${REPEATS_PER_LEVEL} ...`)

            let result
            try {
                result = await runBatch(client, wallet, concurrency)
            } catch (e) {
                log(`  [오류] ${e.message}`)
                continue
            }

            summary[concurrency].push(result.batchElapsed)

            log(`    배치 전체  : ${result.batchElapsed.toFixed(0)} ms`)
            log(`    개별 평균  : ${result.avgIndiv.toFixed(0)} ms`)
            log(`    개별 min   : ${result.minIndiv.toFixed(0)} ms`)
            log(`    개별 max   : ${result.maxIndiv.toFixed(0)} ms`)
            log(`    성공/실패  : ${result.successCount}/${result.failCount}`)

            csvRows.push([
                concurrency,
                rep,
                result.batchElapsed.toFixed(3),
                result.avgIndiv.toFixed(3),
                result.minIndiv.toFixed(3),
                result.maxIndiv.toFixed(3),
                result.successCount,
                result.failCount,
            ].join(","))

            // 다음 반복 전 대기 (네트워크 안정화)
            await sleep(2000)
        }

        // 조건별 요약
        const batches = summary[concurrency]
        if (batches.length > 0) {
            const avg = batches.reduce((a, b) => a + b, 0) / batches.length
            const std = sampleStdDev(batches)
            const p95 = percentileLinear(batches, 95)
            log(`\n  [동시 ${concurrency}개 요약]`)
            log(`  배치 평균  : ${avg.toFixed(0)} ms`)
            log(`  배치 std   : ${std.toFixed(0)} ms`)
            log(`  배치 p95   : ${p95.toFixed(0)} ms\n`)
        }
    }

    // ============================================================
    // 전체 요약
    // ============================================================
    log("================================================================")
    log("[전체 요약]")
    log("================================================================")
    log(
        pad("동시 제출 수", 12),
        pad("배치 평균(ms)", 16),
        pad("배치 std(ms)", 16),
        pad("배치 p95(ms)", 16)
    )
    log("-".repeat(64))

    const summaryRows = []
    summaryRows.push("concurrency,avg_batch_ms,std_batch_ms,p95_batch_ms")

    for (const concurrency of CONCURRENCY_LEVELS) {
        const batches = summary[concurrency]
        if (batches.length === 0) continue
        const avg = batches.reduce((a, b) => a + b, 0) / batches.length
        const std = sampleStdDev(batches)
        const p95 = percentileLinear(batches, 95)
        log(
            pad(concurrency, 12),
            pad(avg.toFixed(0), 16),
            pad(std.toFixed(0), 16),
            pad(p95.toFixed(0), 16)
        )
        summaryRows.push(`${concurrency},${avg.toFixed(3)},${std.toFixed(3)},${p95.toFixed(3)}`)
    }

    // ============================================================
    // 파일 저장
    // ============================================================
    fs.writeFileSync(OUTPUT_CSV, csvRows.join("\n") + "\n", "utf8")
    fs.writeFileSync(
        "concurrent_load_summary_ext.csv",
        summaryRows.join("\n") + "\n",
        "utf8"
    )
    fs.writeFileSync(OUTPUT_TXT, lines.join("\n") + "\n", "utf8")

    log("\n저장 파일:")
    log(`  ${OUTPUT_CSV}          — 반복별 상세 데이터`)
    log(`  concurrent_load_summary.csv  — 조건별 요약 통계`)
    log(`  ${OUTPUT_TXT}          — 실험 상세 로그`)

    await client.disconnect()
    log("\n=== Step A 완료 ===")
}

main().catch(e => {
    console.error("실험 오류:", e)
    process.exit(1)
})
