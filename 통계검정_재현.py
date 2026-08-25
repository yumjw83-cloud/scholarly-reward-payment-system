# -*- coding: utf-8 -*-
"""
논문 4.3.2절 통계 검정 재현 스크립트
================================================================
대상   : 에스크로 모드 간 EscrowFinish 지연시간(ms) 차이 검정
파이프라인 : 기술통계 → Shapiro-Wilk(정규성) → Welch t-test + Mann-Whitney U → Cohen's d + 차이 95% CI
원자료 : 같은 폴더의 xrpl_results_time.csv / xrpl_results_condition.csv / xrpl_results_cancel.csv
표본   : 논문은 각 모드 '앞 100행'(n=100)을 사용 → 아래 N=100

필요 패키지 : pandas, scipy, numpy
설치        : pip install pandas scipy numpy
실행        : python 통계검정_재현.py
================================================================
왜 이 순서인가:
- 지연시간이 이중봉(bimodal)·비정규라서 평균 기반 t검정만으로는 부족하다.
- 그래서 (1) 정규성부터 확인하고, (2) 모수 검정(Welch t)과 (3) 비모수 검정(Mann-Whitney)을
  '병행'하여 결론의 강건성을 본다. (4) p값은 표본크기에 좌우되므로 효과크기(Cohen's d)를 함께 본다.
"""
import os
import numpy as np
import pandas as pd
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
N = 100          # 논문 표본수(각 모드 앞 100행). 전체 행을 쓰려면 N = None 으로.
COL = "finish_ms"  # 비교할 지연시간 컬럼. create_ms 로 바꾸면 EscrowCreate 비교.


def load(mode, col=COL, n=N):
    """xrpl_results_{mode}.csv 에서 지연시간 컬럼을 읽어 앞 n개를 반환."""
    path = os.path.join(HERE, f"xrpl_results_{mode}.csv")
    s = pd.read_csv(path)[col].dropna().astype(float)
    return s.iloc[:n].values if n else s.values


def describe(x):
    q1, q3 = np.percentile(x, [25, 75])
    se = x.std(ddof=1) / np.sqrt(len(x))
    return dict(n=len(x), mean=x.mean(), median=np.median(x), sd=x.std(ddof=1),
                iqr=q3 - q1, ci_lo=x.mean() - 1.96 * se, ci_hi=x.mean() + 1.96 * se,
                p95=np.percentile(x, 95))


def cohen_d(a, b):
    """pooled SD 기반 Cohen's d (효과크기)."""
    na, nb = len(a), len(b)
    sp = np.sqrt(((na - 1) * a.std(ddof=1) ** 2 + (nb - 1) * b.std(ddof=1) ** 2) / (na + nb - 2))
    return (a.mean() - b.mean()) / sp


def welch_diff_ci(a, b, alpha=0.05):
    """평균 차이(a-b)의 Welch 신뢰구간과 자유도."""
    diff = a.mean() - b.mean()
    va, vb, na, nb = a.var(ddof=1), b.var(ddof=1), len(a), len(b)
    se = np.sqrt(va / na + vb / nb)
    df = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1))
    tcrit = stats.t.ppf(1 - alpha / 2, df)
    return diff, diff - tcrit * se, diff + tcrit * se, df


def compare(a, b, label_a, label_b):
    print("=" * 66)
    print(f"비교:  {label_a}   vs   {label_b}")
    print("=" * 66)

    # 0) 기술통계
    for lab, x in [(label_a, a), (label_b, b)]:
        d = describe(x)
        print(f"[{lab}] n={d['n']}  평균={d['mean']:.1f}  중앙값={d['median']:.0f}  "
              f"SD={d['sd']:.1f}  IQR={d['iqr']:.0f}  95%CI=[{d['ci_lo']:.0f}, {d['ci_hi']:.0f}]  p95={d['p95']:.0f}")

    # 1) 정규성 검정
    print("\n[1] Shapiro-Wilk 정규성 검정  (H0: 정규분포 / p<0.05면 비정규 → 비모수 검정 병행 필요)")
    for lab, x in [(label_a, a), (label_b, b)]:
        w = stats.shapiro(x)
        print(f"    {lab}: W={w.statistic:.3f}, p={w.pvalue:.2e}  →  {'비정규' if w.pvalue < 0.05 else '정규'}")

    # 2) Welch t-test (등분산 미가정)
    t = stats.ttest_ind(a, b, equal_var=False)
    diff, lo, hi, df = welch_diff_ci(a, b)
    print(f"\n[2] Welch t-test (모수, 등분산 미가정):  t={t.statistic:.2f},  df={df:.1f},  p={t.pvalue:.3f}")
    inc0 = " (0을 포함 → 유의한 차이 아님)" if lo < 0 < hi else ""
    print(f"    평균차={diff:.1f} ms,  95% CI=[{lo:.0f}, {hi:.0f}]{inc0}")

    # 3) Mann-Whitney U (비모수)
    u = stats.mannwhitneyu(a, b, alternative="two-sided")
    print(f"\n[3] Mann-Whitney U (비모수):  U={u.statistic:.0f},  p={u.pvalue:.3f}")

    # 4) 효과크기
    d = cohen_d(a, b)
    mag = "작음" if abs(d) < 0.5 else ("중간" if abs(d) < 0.8 else "큼")
    print(f"\n[4] 효과크기 Cohen's d = {d:.2f}  ({mag};  |d|≈0.2 작음·0.5 중간·0.8 큼)")

    # 판정
    verdict = "유의한 차이 없음" if (t.pvalue >= 0.05 and u.pvalue >= 0.05) else "유의한 차이 있음"
    print(f"\n판정 (α=0.05):  {verdict}   [Welch p={t.pvalue:.3f}, Mann-Whitney p={u.pvalue:.3f}]")
    print("주: p값은 표본크기에 민감하므로 효과크기와 함께 해석. n=100에서 소효과 검출력은 제한적.\n")


if __name__ == "__main__":
    # ── 논문의 핵심 검정: CONDITION vs TIME (EscrowFinish 지연) ──
    cond = load("condition")
    time = load("time")
    compare(cond, time, "CONDITION EscrowFinish", "TIME EscrowFinish")

    print("[논문 4.3.2 보고값]  평균 6047.7 vs 5811.3,  차이 236 ms,  t=1.45,  p=0.148,")
    print("                     Mann-Whitney p=0.192,  Cohen's d=0.21,  차이 95%CI=[-85, 558]")
    print("                     → 위 [2][3][4] 결과와 일치하면 재현 성공.\n")

    # ── 응용 예시(주석 해제해 사용) ──────────────────────────
    # (a) 다른 모드 비교: CANCEL vs TIME
    #     cancel = load("cancel"); compare(cancel, time, "CANCEL", "TIME EscrowFinish")
    # (b) EscrowCreate 지연 비교: COL 을 "create_ms" 로 바꾸거나 load(..., col="create_ms")
    #     compare(load("condition", col="create_ms"), load("time", col="create_ms"),
    #             "CONDITION EscrowCreate", "TIME EscrowCreate")
    # (c) 내 새 데이터: 두 그룹을 numpy 배열로 만들어 compare(그룹A, 그룹B, "A", "B") 호출
