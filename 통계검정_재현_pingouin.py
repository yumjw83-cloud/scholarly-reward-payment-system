# -*- coding: utf-8 -*-
"""
논문 4.3.2절 통계 검정 재현 — pingouin 버전 (SPSS식 요약표 출력)
================================================================
scipy 버전(통계검정_재현.py)과 동일한 검정을, SPSS 'Explore + 독립표본 t검정'처럼
표로 출력한다. pingouin은 t·자유도·p·신뢰구간·효과크기·검정력·베이즈요인을 한 번에 준다.

필요 패키지 : pip install pingouin   (pandas·scipy·statsmodels를 함께 설치)
실행        : python 통계검정_재현_pingouin.py
원자료      : 같은 폴더 xrpl_results_{time,condition,cancel}.csv
표본        : 논문과 동일하게 각 모드 앞 100행(N=100)
================================================================
"""
import os
import numpy as np
import pandas as pd
import pingouin as pg
from scipy import stats

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 30)

HERE = os.path.dirname(os.path.abspath(__file__))
N = 100            # 논문 표본수(각 모드 앞 100행). 전체 행을 쓰려면 None
COL = "finish_ms"  # 비교 컬럼. "create_ms"로 바꾸면 EscrowCreate 비교


def load(mode, col=COL, n=N):
    s = pd.read_csv(os.path.join(HERE, "xrpl_results_" + mode + ".csv"))[col].dropna().astype(float)
    return s.iloc[:n].values if n else s.values


def descriptives(groups):
    rows = []
    for name, x in groups.items():
        q1, q3 = np.percentile(x, [25, 75])
        se = x.std(ddof=1) / np.sqrt(len(x))
        rows.append({
            "그룹": name, "n": len(x), "평균": round(x.mean(), 1),
            "표준편차": round(x.std(ddof=1), 1), "중앙값": round(np.median(x), 1),
            "IQR": round(q3 - q1, 1), "CI95_하한": round(x.mean() - 1.96 * se, 1),
            "CI95_상한": round(x.mean() + 1.96 * se, 1), "p95": round(np.percentile(x, 95), 1),
        })
    return pd.DataFrame(rows).set_index("그룹")


def run(a, b, la, lb):
    long = pd.DataFrame({"지연시간": np.r_[a, b], "그룹": [la] * len(a) + [lb] * len(b)})

    print("=" * 70)
    print("독립표본 비교:  " + la + "  vs  " + lb + "   (지연시간 ms)")
    print("=" * 70)

    print("\n[1] 기술통계 (Descriptives)")
    print(descriptives({la: a, lb: b}).to_string())

    print("\n[2] 정규성 검정 (Shapiro-Wilk)  — normal=False면 비정규 → 비모수 병행")
    nrm = pg.normality(long, dv="지연시간", group="그룹").copy()
    nrm["W"] = nrm["W"].round(4)
    nrm["pval"] = nrm["pval"].map(lambda p: "<.001" if p < 0.001 else format(p, ".4f"))
    print(nrm.to_string())

    print("\n[3] 등분산 검정 (Levene)  — equal_var=False(Welch) 채택 근거")
    print(pg.homoscedasticity(long, dv="지연시간", group="그룹").round(4).to_string())

    print("\n[4] 독립표본 t검정 (Welch, correction=True)")
    print("    T·dof·p-val·CI95(평균차)·cohen-d(효과크기)·power(검정력)·BF10")
    print(pg.ttest(a, b, correction=True).round(3).to_string())

    print("\n[5] Mann-Whitney U (비모수)  — U·p-val·RBC(순위이연상관)·CLES")
    print(pg.mwu(a, b, alternative="two-sided").round(3).to_string())

    # 판정용 p값은 scipy로 견고하게 계산(표는 pingouin, 결론은 scipy — 값은 동일)
    tp = float(stats.ttest_ind(a, b, equal_var=False).pvalue)
    mp = float(stats.mannwhitneyu(a, b, alternative="two-sided").pvalue)
    verdict = "유의한 차이 없음" if (tp >= 0.05 and mp >= 0.05) else "유의한 차이 있음"
    print("\n판정 (a=0.05): " + verdict + "  [Welch p=" + format(tp, ".3f") + ", Mann-Whitney p=" + format(mp, ".3f") + "]")
    print("주: p값은 표본크기에 민감. 효과크기(Cohen's d)·검정력(power)과 함께 해석.")


if __name__ == "__main__":
    run(load("condition"), load("time"), "CONDITION", "TIME")
    print("\n[논문 4.3.2 보고값] t=1.45, p=0.148, Mann-Whitney p=0.192, Cohen d=0.21, 차이 95%CI=[-85,558]")
    print("                    -> 위 [4][5] 결과와 일치하면 재현 성공")
    # 응용: run(load("cancel"), load("time"), "CANCEL", "TIME")
    #       COL="create_ms"로 바꾸면 EscrowCreate 비교
