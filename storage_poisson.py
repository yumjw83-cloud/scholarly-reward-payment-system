"""
================================================================
온체인 저장량 추정 및 부하 한계 추정 (Step 4)
================================================================

실험 목적:
    3.4.2절 저장량 추정 수식을 계산하고,
    Xie(2020) 푸아송 모델을 적용하여
    부하 증가에 따른 처리 한계를 추정한다.

산출 항목:
    [4.3.3절] 시나리오별 저장량 추정 결과
        - 소규모(S) / 중규모(M) / 대규모(L)
        - 1년 / 3년 누적 / 5년 누적 / 10년 누적
    [4.3.4절] 부하 증가에 따른 저장량 및 처리 한계 추정
        - 푸아송 도달률 λ(y) 계산
        - XRPL 처리 한계(1,500 TPS) 대비 여유율
        - 한계 도달 시점 추정

수식 정의 (3.4.2절):
    G_chain(y) = N_p(y) × s_reg + N_u(y) × s_event
    N_p(y)     = N_p(0) × (1 + r_p)^y
    N_u(y)     = N_p(y) × N_model(y) × r_inclusion
    N_model(y) = N_model(0) × (1 + r_m)^y

파라미터:
    s_reg   = 1,920 bytes  (논문 1편 등록 고정 저장량, A_p=4 기준)
    s_event = 1,024 bytes  (이벤트 1건당 저장량)
    r_p     = 4%           (논문 연간 증가율, White 2019)
    r_m     = 50%          (AI 모델 연간 증가율, Maslej et al. 2025)

참고문헌:
    Xie, J. (2020). Modeling heterogeneous performance in distributed
        ledgers. IEEE Access, 8, 1–12.
    White, K. (2019). NSB-2020-6. National Science Foundation.
    Maslej, N., et al. (2025). AI Index Report 2025. arXiv:2504.07139.

실행 방법:
    python storage_poisson.py

출력 파일:
    storage_results.txt  — 계산 결과 전문
    storage_results.csv  — 시나리오별 수치 (논문 표 입력용)
================================================================
"""

import math
import csv
import os
from datetime import datetime

# ================================================================
# 고정 파라미터 (3.4.1절 / 3.4.2절)
# ================================================================

S_REG   = 1_920   # bytes — 논문 1편 등록 고정 저장량 (A_p=4)
S_EVENT = 1_024   # bytes — AI 학습 활용 이벤트 1건당 저장량
R_P     = 0.04    # 논문 연간 증가율 (White, 2019; Bornmann & Mutz, 2021)
R_M     = 0.50    # AI 모델 연간 증가율 (Maslej et al., 2025)

# XRPL 처리 한계 (선행연구 기준)
# Wicaksono et al.(2025): XRPL 실측 최대 처리량 1,500 TPS
XRPL_MAX_TPS = 1_500

# 시나리오 정의
SCENARIOS = {
    "소규모 (S)": {
        "N_p0":        10_000,
        "N_model0":    10,
        "r_inclusion": 0.01,
    },
    "중규모 (M)": {
        "N_p0":        50_000,
        "N_model0":    30,
        "r_inclusion": 0.05,
    },
    "대규모 (L)": {
        "N_p0":        200_000,
        "N_model0":    100,
        "r_inclusion": 0.10,
    },
}

YEARS = [1, 3, 5, 10]

# ================================================================
# 수식 함수 (3.4.2절)
# ================================================================

def N_p(N_p0: float, y: int) -> float:
    """연도 y의 누적 등록 논문 수"""
    return N_p0 * (1 + R_P) ** y


def N_model(N_model0: float, y: int) -> float:
    """연도 y의 누적 AI 모델 수"""
    return N_model0 * (1 + R_M) ** y


def N_u(N_p0: float, N_model0: float, r_inclusion: float, y: int) -> float:
    """연도 y의 AI 학습 활용 이벤트 수"""
    return N_p(N_p0, y) * N_model(N_model0, y) * r_inclusion


def G_chain_annual(N_p0: float, N_model0: float, r_inclusion: float, y: int) -> float:
    """연도 y의 연간 온체인 저장량 (bytes)"""
    return N_p(N_p0, y) * S_REG + N_u(N_p0, N_model0, r_inclusion, y) * S_EVENT


def G_chain_cumulative(N_p0: float, N_model0: float, r_inclusion: float, y: int) -> float:
    """연도 1~y 누적 온체인 저장량 (bytes)"""
    return sum(G_chain_annual(N_p0, N_model0, r_inclusion, t) for t in range(1, y + 1))


def bytes_to_gb(b: float) -> float:
    return b / (1024 ** 3)


# ================================================================
# 푸아송 모델 함수 (4.3.4절, Xie 2020)
# ================================================================

def lambda_y(N_p0: float, N_model0: float, r_inclusion: float, y: int) -> float:
    """
    연도 y의 초당 평균 이벤트 도달률 λ(y) (TPS 단위)

    푸아송 모델 적용 (Xie, 2020):
        λ(y) = N_u(y) / (365 × 24 × 3600)
    연간 이벤트 수를 초당 도달률로 환산한다.
    """
    seconds_per_year = 365 * 24 * 3600
    return N_u(N_p0, N_model0, r_inclusion, y) / seconds_per_year


def tps_utilization(lam: float) -> float:
    """XRPL 최대 처리량 대비 이용률 (%)"""
    return (lam / XRPL_MAX_TPS) * 100


def find_saturation_year(N_p0: float, N_model0: float, r_inclusion: float,
                          max_year: int = 50) -> int | None:
    """
    λ(y) ≥ XRPL_MAX_TPS가 되는 최초 연도를 반환한다.
    max_year 이내에 도달하지 않으면 None을 반환한다.
    """
    for y in range(1, max_year + 1):
        if lambda_y(N_p0, N_model0, r_inclusion, y) >= XRPL_MAX_TPS:
            return y
    return None


# ================================================================
# 출력 유틸리티
# ================================================================

LOG_FILE = "storage_results.txt"
CSV_FILE = "storage_results.csv"

with open(LOG_FILE, "w", encoding="utf-8") as f:
    f.write(f"온체인 저장량 추정 및 부하 한계 추정\n")
    f.write(f"실행시각: {datetime.now().strftime('%Y. %m. %d. %H:%M:%S')}\n")
    f.write("=" * 64 + "\n")


def log(msg: str = "") -> None:
    print(msg)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(msg + "\n")


def log_section(title: str) -> None:
    log(f"\n{'─' * 64}\n[{title}]\n{'─' * 64}")


# ================================================================
# 메인 계산 실행
# ================================================================

def main() -> None:

    log("파라미터 설정")
    log(f"  s_reg        = {S_REG:,} bytes")
    log(f"  s_event      = {S_EVENT:,} bytes")
    log(f"  r_p          = {R_P*100:.0f}%  (논문 연간 증가율)")
    log(f"  r_m          = {R_M*100:.0f}%  (AI 모델 연간 증가율)")
    log(f"  XRPL 최대TPS = {XRPL_MAX_TPS:,} TPS")

    # ── 4.3.3절: 시나리오별 저장량 추정 ─────────────────────
    log_section("4.3.3 시나리오별 저장량 추정")

    csv_rows = []

    for name, sc in SCENARIOS.items():
        N_p0        = sc["N_p0"]
        N_model0    = sc["N_model0"]
        r_inclusion = sc["r_inclusion"]

        log(f"\n  ▶ {name}")
        log(f"    N_p(0)={N_p0:,}편  N_model(0)={N_model0}개"
            f"  r_inclusion={r_inclusion*100:.0f}%")

        row = {"시나리오": name}

        for y in YEARS:
            annual = G_chain_annual(N_p0, N_model0, r_inclusion, y)
            cumul  = G_chain_cumulative(N_p0, N_model0, r_inclusion, y)
            np_y   = N_p(N_p0, y)
            nu_y   = N_u(N_p0, N_model0, r_inclusion, y)

            label_a = f"{y}년 연간"
            label_c = f"{y}년 누적"

            log(f"    {y:2d}년: 연간={bytes_to_gb(annual):.4f} GB"
                f"  누적={bytes_to_gb(cumul):.4f} GB"
                f"  (N_p={np_y:,.0f}편, N_u={nu_y:,.0f}건)")

            row[label_a] = f"{bytes_to_gb(annual):.4f}"
            row[label_c] = f"{bytes_to_gb(cumul):.4f}"

        csv_rows.append(row)

    # CSV 저장 (논문 표 입력용)
    fieldnames = ["시나리오"] + [
        f for y in YEARS for f in (f"{y}년 연간", f"{y}년 누적")
    ]
    with open(CSV_FILE, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(csv_rows)

    # ── 4.3.4절: 푸아송 모델 부하 한계 추정 ─────────────────
    log_section("4.3.4 부하 증가에 따른 처리 한계 추정 (푸아송 모델)")

    log(f"\n  모델 근거: Xie(2020) 푸아송 도달률 모델")
    log(f"  λ(y) = N_u(y) / (365 × 24 × 3600)  [TPS]")
    log(f"  XRPL 처리 한계 = {XRPL_MAX_TPS:,} TPS (Wicaksono et al., 2025)\n")

    # CSV에 TPS 결과 추가
    tps_rows = []

    for name, sc in SCENARIOS.items():
        N_p0        = sc["N_p0"]
        N_model0    = sc["N_model0"]
        r_inclusion = sc["r_inclusion"]

        log(f"  ▶ {name}")

        sat_year = find_saturation_year(N_p0, N_model0, r_inclusion)

        tps_row = {"시나리오": name}
        for y in [1, 3, 5, 10, 20, 30]:
            lam   = lambda_y(N_p0, N_model0, r_inclusion, y)
            util  = tps_utilization(lam)
            log(f"    {y:2d}년: λ={lam:.6f} TPS  이용률={util:.4f}%")
            tps_row[f"{y}년_TPS"] = f"{lam:.6f}"
            tps_row[f"{y}년_이용률(%)"] = f"{util:.6f}"

        if sat_year:
            log(f"    → 포화 도달 연도: {sat_year}년 (λ ≥ {XRPL_MAX_TPS:,} TPS)")
        else:
            log(f"    → 포화 도달: 30년 이내 미도달 (실용 범위 내 확장 가능)")

        tps_row["포화_도달_연도"] = str(sat_year) if sat_year else "30년 이내 미도달"
        tps_rows.append(tps_row)

    # TPS 결과를 CSV에 추가
    tps_fieldnames = ["시나리오"] + [
        f for y in [1, 3, 5, 10, 20, 30]
        for f in (f"{y}년_TPS", f"{y}년_이용률(%)")
    ] + ["포화_도달_연도"]

    tps_csv = "storage_tps_results.csv"
    with open(tps_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=tps_fieldnames)
        writer.writeheader()
        writer.writerows(tps_rows)

    # ── 결과 요약 ─────────────────────────────────────────────
    log_section("실험 결과 요약")

    log("  [저장량 추정]")
    log(f"  {'시나리오':<12}  {'1년 연간':>12}  {'5년 누적':>12}  {'10년 누적':>12}")
    log(f"  {'-'*54}")
    for name, sc in SCENARIOS.items():
        a1  = bytes_to_gb(G_chain_annual(sc['N_p0'], sc['N_model0'], sc['r_inclusion'], 1))
        c5  = bytes_to_gb(G_chain_cumulative(sc['N_p0'], sc['N_model0'], sc['r_inclusion'], 5))
        c10 = bytes_to_gb(G_chain_cumulative(sc['N_p0'], sc['N_model0'], sc['r_inclusion'], 10))
        log(f"  {name:<12}  {a1:>12.4f} GB  {c5:>12.4f} GB  {c10:>12.4f} GB")

    log("")
    log("  [XRPL 처리 여유율 — 10년 시점]")
    for name, sc in SCENARIOS.items():
        lam  = lambda_y(sc['N_p0'], sc['N_model0'], sc['r_inclusion'], 10)
        util = tps_utilization(lam)
        log(f"  {name:<12}  λ(10)={lam:.6f} TPS  이용률={util:.4f}%")

    log("")
    log("저장 파일:")
    log(f"  {LOG_FILE}        — 계산 결과 전문")
    log(f"  {CSV_FILE}  — 저장량 시나리오 (논문 표 입력용)")
    log(f"  {tps_csv}  — TPS 부하 추정 결과")
    log("")
    log("=== Step 4 완료 — 4.3.3 / 4.3.4절 수치 산출 완료 ✅ ===")


if __name__ == "__main__":
    main()
