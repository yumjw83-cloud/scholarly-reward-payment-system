"""
================================================================
논문 그림 생성 스크립트
================================================================

생성 그림 목록:
    [4.3.2절] 트랜잭션 처리 지연시간
        Fig1_latency_boxplot.png    — 모드별 지연시간 박스플롯
        Fig2_latency_histogram.png  — 모드별 지연시간 히스토그램

    [4.3.3절] 저장량 추정
        Fig3_storage_growth.png     — 시나리오별 누적 저장량 증가

    [4.3.4절] 부하 한계 추정
        Fig4_tps_utilization.png    — 연도별 TPS 이용률

    [통합 실험]
        Fig5_integration_latency.png — End-to-End 소요 시간

입력 파일:
    xrpl_results_time.csv
    xrpl_results_condition.csv
    xrpl_results_cancel.csv
    integration_results.csv
    storage_results.csv
    storage_tps_results.csv

실행 방법:
    python visualize.py

출력: 모든 그림은 figures/ 폴더에 저장된다.
================================================================
"""

import os
import csv
import math
import warnings
import numpy as np
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.ticker import FuncFormatter

warnings.filterwarnings("ignore")
matplotlib.rcParams.update({
    "font.family":     "DejaVu Sans",
    "font.size":       11,
    "axes.titlesize":  13,
    "axes.labelsize":  11,
    "xtick.labelsize": 10,
    "ytick.labelsize": 10,
    "legend.fontsize": 10,
    "figure.dpi":      150,
    "savefig.dpi":     300,
    "savefig.bbox":    "tight",
    "axes.spines.top":    False,
    "axes.spines.right":  False,
})

OUTPUT_DIR = "figures"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ================================================================
# 데이터 로더
# ================================================================

def load_xrpl_csv(filepath):
    """XRPL 실험 CSV에서 수치 행만 읽어 반환한다."""
    rows = {"create_ms": [], "create_fee": [], "finish_ms": [], "finish_fee": []}
    if not os.path.exists(filepath):
        print(f"  [경고] 파일 없음: {filepath}")
        return rows
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            # 요약 행(AVERAGE, STDDEV 등) 제외
            try:
                it = int(row.get("iteration", "x"))
            except ValueError:
                continue
            # cancel 모드는 finish_ms → cancel_ms
            cols = list(row.keys())
            finish_col = [c for c in cols if "finish_ms" in c or "cancel_ms" in c]
            fee_col    = [c for c in cols if "finish_fee" in c or "cancel_fee" in c]
            rows["create_ms"].append(float(row["create_ms"]))
            rows["create_fee"].append(float(row["create_fee_drops"]))
            rows["finish_ms"].append(float(row[finish_col[0]]) if finish_col else 0)
            rows["finish_fee"].append(float(row[fee_col[0]])   if fee_col    else 0)
    return rows


def load_storage_csv(filepath):
    """저장량 CSV에서 시나리오별 연간·누적 GB 값을 반환한다."""
    result = {}
    if not os.path.exists(filepath):
        print(f"  [경고] 파일 없음: {filepath}")
        return result
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["시나리오"]
            result[name] = {k: float(v) for k, v in row.items() if k != "시나리오"}
    return result


def load_tps_csv(filepath):
    """TPS CSV에서 시나리오별 연도별 이용률을 반환한다."""
    result = {}
    if not os.path.exists(filepath):
        print(f"  [경고] 파일 없음: {filepath}")
        return result
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["시나리오"]
            result[name] = {k: float(v) for k, v in row.items()
                            if "이용률" in k}
    return result


def load_integration_csv(filepath):
    """통합 실험 CSV에서 Phase1·Create·Finish 수치를 반환한다."""
    rows = {"phase1_ms": [], "create_ms": [], "finish_ms": []}
    if not os.path.exists(filepath):
        print(f"  [경고] 파일 없음: {filepath}")
        return rows
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                int(row.get("iteration", "x"))
            except ValueError:
                continue
            rows["phase1_ms"].append(float(row["phase1_ms"]))
            rows["create_ms"].append(float(row["create_ms"]))
            rows["finish_ms"].append(float(row["finish_ms"]))
    return rows

# ================================================================
# Fig 1: 모드별 지연시간 박스플롯 (4.3.2절)
# ================================================================

def fig1_latency_boxplot(time_d, cond_d, canc_d):
    print("  Fig1_latency_boxplot.png 생성 중...")

    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    fig.suptitle("Transaction Latency by Mode (XRPL Testnet, n=100)",
                 fontsize=13, y=1.01)

    colors    = ["#4C72B0", "#DD8452", "#55A868"]
    labels    = ["Time", "Condition", "Cancel"]
    datasets  = [time_d, cond_d, canc_d]
    op_labels = ["EscrowCreate", "EscrowFinish / EscrowCancel"]
    keys      = [("create_ms", "finish_ms")]

    for ax_idx, (create_key, finish_key) in enumerate(keys):
        ax = axes[ax_idx]
        data_c = [d[create_key]  for d in datasets]
        data_f = [d[finish_key]  for d in datasets]

        positions_c = [1, 3, 5]
        positions_f = [2, 4, 6]

        bp_c = ax.boxplot(data_c, positions=positions_c, widths=0.7,
                          patch_artist=True, notch=False,
                          medianprops={"color": "black", "linewidth": 2})
        bp_f = ax.boxplot(data_f, positions=positions_f, widths=0.7,
                          patch_artist=True, notch=False,
                          medianprops={"color": "black", "linewidth": 2})

        for patch, color in zip(bp_c["boxes"], colors):
            patch.set_facecolor(color)
            patch.set_alpha(0.8)
        for patch, color in zip(bp_f["boxes"], colors):
            patch.set_facecolor(color)
            patch.set_alpha(0.4)

        ax.set_xticks([1.5, 3.5, 5.5])
        ax.set_xticklabels(labels)
        ax.set_ylabel("Latency (ms)")
        ax.set_title("EscrowCreate vs EscrowFinish/Cancel")
        ax.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))

        solid = mpatches.Patch(facecolor="gray", alpha=0.8, label="EscrowCreate")
        light = mpatches.Patch(facecolor="gray", alpha=0.4, label="EscrowFinish / EscrowCancel")
        ax.legend(handles=[solid, light], loc="upper right")
        ax.grid(axis="y", linestyle="--", alpha=0.4)
        break  # 1개 axes만 사용

    # 두 번째 axes: 수수료 비교
    ax2 = axes[1]
    fee_data = [
        [time_d["create_fee"], time_d["finish_fee"]],
        [cond_d["create_fee"], cond_d["finish_fee"]],
        [canc_d["create_fee"], canc_d["finish_fee"]]
    ]
    bar_width = 0.25
    x = np.arange(2)
    op_labels_short = ["EscrowCreate", "EscrowFinish/Cancel"]

    for i, (label, fees, color) in enumerate(zip(labels, fee_data, colors)):
        means = [np.mean(f) if f else 0 for f in fees]
        ax2.bar(x + i * bar_width, means, bar_width,
                label=label, color=color, alpha=0.85, edgecolor="white")

    ax2.set_xticks(x + bar_width)
    ax2.set_xticklabels(op_labels_short)
    ax2.set_ylabel("Fee (drops)")
    ax2.set_title("Average Transaction Fee by Mode")
    ax2.legend()
    ax2.grid(axis="y", linestyle="--", alpha=0.4)

    plt.tight_layout()
    out = os.path.join(OUTPUT_DIR, "Fig1_latency_boxplot.png")
    plt.savefig(out)
    plt.close()
    print(f"  → 저장: {out}")


# ================================================================
# Fig 2: 모드별 지연시간 히스토그램 (4.3.2절)
# ================================================================

def fig2_latency_histogram(time_d, cond_d, canc_d):
    print("  Fig2_latency_histogram.png 생성 중...")

    fig, axes = plt.subplots(2, 3, figsize=(13, 7))
    fig.suptitle("Latency Distribution by Mode (XRPL Testnet, n=100)", fontsize=13)

    modes   = ["Time", "Condition", "Cancel"]
    data_s  = [time_d, cond_d, canc_d]
    colors  = ["#4C72B0", "#DD8452", "#55A868"]
    ops     = [("create_ms", "EscrowCreate"), ("finish_ms", "EscrowFinish/Cancel")]

    for row_idx, (key, op_label) in enumerate(ops):
        for col_idx, (mode, d, color) in enumerate(zip(modes, data_s, colors)):
            ax  = axes[row_idx][col_idx]
            arr = d[key]
            if not arr:
                ax.text(0.5, 0.5, "No data", ha="center", va="center",
                        transform=ax.transAxes)
                continue

            ax.hist(arr, bins=20, color=color, alpha=0.75, edgecolor="white")
            ax.axvline(np.mean(arr),   color="black",  linewidth=1.5,
                       linestyle="--", label=f"Mean={np.mean(arr):.0f}ms")
            ax.axvline(np.percentile(arr, 95), color="red", linewidth=1.5,
                       linestyle=":",  label=f"p95={np.percentile(arr,95):.0f}ms")

            ax.set_title(f"{mode} — {op_label}")
            ax.set_xlabel("Latency (ms)")
            ax.set_ylabel("Count")
            ax.legend(fontsize=8)
            ax.grid(axis="y", linestyle="--", alpha=0.3)
            ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))

    plt.tight_layout()
    out = os.path.join(OUTPUT_DIR, "Fig2_latency_histogram.png")
    plt.savefig(out)
    plt.close()
    print(f"  → 저장: {out}")


# ================================================================
# Fig 3: 시나리오별 누적 저장량 (4.3.3절)
# ================================================================

def fig3_storage_growth(storage_d):
    print("  Fig3_storage_growth.png 생성 중...")

    if not storage_d:
        print("  [건너뜀] 저장량 데이터 없음")
        return

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    fig.suptitle("On-Chain Storage Growth by Scenario", fontsize=13)

    years    = [1, 3, 5, 10]
    colors   = ["#4C72B0", "#DD8452", "#55A868"]
    markers  = ["o", "s", "^"]
    scenario_short = {"소규모 (S)": "Small (S)", "중규모 (M)": "Medium (M)", "대규모 (L)": "Large (L)"}

    # 왼쪽: 연간 저장량
    ax1 = axes[0]
    for (name, data), color, marker in zip(storage_d.items(), colors, markers):
        annual = [data.get(f"{y}년 연간", 0) for y in years]
        ax1.plot(years, annual, color=color, marker=marker, linewidth=2,
                 markersize=7, label=scenario_short.get(name, name))
    ax1.set_xlabel("Year")
    ax1.set_ylabel("Annual Storage (GB)")
    ax1.set_title("Annual On-Chain Storage")
    ax1.set_xticks(years)
    ax1.legend()
    ax1.grid(linestyle="--", alpha=0.4)
    ax1.set_yscale("log")
    ax1.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x:.3f}"))

    # 오른쪽: 누적 저장량
    ax2 = axes[1]
    for (name, data), color, marker in zip(storage_d.items(), colors, markers):
        cumul = [data.get(f"{y}년 누적", 0) for y in years]
        ax2.plot(years, cumul, color=color, marker=marker, linewidth=2,
                 markersize=7, label=scenario_short.get(name, name))
        # 10년 값 레이블
        ax2.annotate(f"{cumul[-1]:.2f} GB",
                     xy=(years[-1], cumul[-1]),
                     xytext=(8, 0), textcoords="offset points",
                     fontsize=9, color=color)
    ax2.set_xlabel("Year")
    ax2.set_ylabel("Cumulative Storage (GB)")
    ax2.set_title("Cumulative On-Chain Storage")
    ax2.set_xticks(years)
    ax2.legend()
    ax2.grid(linestyle="--", alpha=0.4)
    ax2.set_yscale("log")
    ax2.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x:.2f}"))

    plt.tight_layout()
    out = os.path.join(OUTPUT_DIR, "Fig3_storage_growth.png")
    plt.savefig(out)
    plt.close()
    print(f"  → 저장: {out}")


# ================================================================
# Fig 4: TPS 이용률 (4.3.4절)
# ================================================================

def fig4_tps_utilization(tps_d):
    print("  Fig4_tps_utilization.png 생성 중...")

    if not tps_d:
        print("  [건너뜀] TPS 데이터 없음")
        return

    fig, ax = plt.subplots(figsize=(9, 5))
    fig.suptitle("XRPL TPS Utilization by Scenario\n"
                 "(XRPL max = 1,500 TPS, Wicaksono et al., 2025)", fontsize=12)

    years   = [1, 3, 5, 10, 20, 30]
    colors  = ["#4C72B0", "#DD8452", "#55A868"]
    markers = ["o", "s", "^"]
    scenario_short = {"소규모 (S)": "Small (S)", "중규모 (M)": "Medium (M)", "대규모 (L)": "Large (L)"}

    for (name, data), color, marker in zip(tps_d.items(), colors, markers):
        util = [data.get(f"{y}년_이용률(%)", 0) for y in years]
        ax.plot(years, util, color=color, marker=marker, linewidth=2,
                markersize=7, label=scenario_short.get(name, name))

    ax.axhline(y=100, color="red", linewidth=1.5, linestyle="--",
               label="Saturation (100% utilization)")
    ax.set_xlabel("Year")
    ax.set_ylabel("TPS Utilization (%)")
    ax.set_xticks(years)
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x:.4f}%"))
    ax.legend()
    ax.grid(linestyle="--", alpha=0.4)

    plt.tight_layout()
    out = os.path.join(OUTPUT_DIR, "Fig4_tps_utilization.png")
    plt.savefig(out)
    plt.close()
    print(f"  → 저장: {out}")


# ================================================================
# Fig 5: 통합 실험 소요 시간 (4.2절)
# ================================================================

def fig5_integration_latency(intg_d):
    print("  Fig5_integration_latency.png 생성 중...")

    if not intg_d["phase1_ms"]:
        print("  [건너뜀] 통합 실험 데이터 없음")
        return

    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    fig.suptitle("End-to-End Integration Experiment Latency", fontsize=13)

    n = len(intg_d["phase1_ms"])

    # 왼쪽: 반복별 소요 시간 꺾은선
    ax1 = axes[0]
    iters = list(range(1, n + 1))
    ax1.plot(iters, intg_d["phase1_ms"],  marker="o", label="Phase1 (DID/VC+IPFS)",
             color="#4C72B0", linewidth=1.5)
    ax1.plot(iters, intg_d["create_ms"],  marker="s", label="EscrowCreate",
             color="#DD8452", linewidth=1.5)
    ax1.plot(iters, intg_d["finish_ms"],  marker="^", label="EscrowFinish",
             color="#55A868", linewidth=1.5)
    ax1.set_xlabel("Iteration")
    ax1.set_ylabel("Latency (ms)")
    ax1.set_title("Per-Iteration Latency")
    ax1.legend()
    ax1.grid(linestyle="--", alpha=0.4)
    ax1.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))

    # 오른쪽: 구간별 평균 막대
    ax2 = axes[1]
    phases = ["Phase1\n(DID/VC+IPFS)", "EscrowCreate", "EscrowFinish"]
    means  = [np.mean(intg_d["phase1_ms"]),
               np.mean(intg_d["create_ms"]),
               np.mean(intg_d["finish_ms"])]
    stds   = [np.std(intg_d["phase1_ms"]),
               np.std(intg_d["create_ms"]),
               np.std(intg_d["finish_ms"])]
    colors = ["#4C72B0", "#DD8452", "#55A868"]
    bars   = ax2.bar(phases, means, color=colors, alpha=0.85,
                     yerr=stds, capsize=6, edgecolor="white")

    for bar, mean_val in zip(bars, means):
        ax2.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 50,
                 f"{mean_val:.0f}ms", ha="center", va="bottom", fontsize=10)

    total_mean = sum(means)
    ax2.axhline(y=total_mean, color="gray", linewidth=1, linestyle=":",
                label=f"Total mean: {total_mean:.0f}ms")
    ax2.set_ylabel("Average Latency (ms)")
    ax2.set_title(f"Average Latency per Phase (n={n})")
    ax2.legend(fontsize=9)
    ax2.grid(axis="y", linestyle="--", alpha=0.4)
    ax2.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))

    plt.tight_layout()
    out = os.path.join(OUTPUT_DIR, "Fig5_integration_latency.png")
    plt.savefig(out)
    plt.close()
    print(f"  → 저장: {out}")


# ================================================================
# 메인 실행
# ================================================================

def main():
    print("=" * 64)
    print("논문 그림 생성 스크립트")
    print(f"출력 폴더: {os.path.abspath(OUTPUT_DIR)}")
    print("=" * 64)

    # 데이터 로드
    print("\n[데이터 로드]")
    time_d    = load_xrpl_csv("xrpl_results_time.csv")
    cond_d    = load_xrpl_csv("xrpl_results_condition.csv")
    canc_d    = load_xrpl_csv("xrpl_results_cancel.csv")
    storage_d = load_storage_csv("storage_results.csv")
    tps_d     = load_tps_csv("storage_tps_results.csv")
    intg_d    = load_integration_csv("integration_results.csv")

    print(f"  Time 모드     : {len(time_d['create_ms'])}회")
    print(f"  Condition 모드: {len(cond_d['create_ms'])}회")
    print(f"  Cancel 모드   : {len(canc_d['create_ms'])}회")
    print(f"  저장량 시나리오: {len(storage_d)}개")
    print(f"  통합 실험     : {len(intg_d['phase1_ms'])}회")

    # 그림 생성
    print("\n[그림 생성]")
    fig1_latency_boxplot(time_d, cond_d, canc_d)
    fig2_latency_histogram(time_d, cond_d, canc_d)
    fig3_storage_growth(storage_d)
    fig4_tps_utilization(tps_d)
    fig5_integration_latency(intg_d)

    print("\n" + "=" * 64)
    print("완료. figures/ 폴더의 PNG 파일을 논문에 삽입하세요.")
    print("=" * 64)
    print("\n생성 파일:")
    for f in sorted(os.listdir(OUTPUT_DIR)):
        if f.endswith(".png"):
            size_kb = os.path.getsize(os.path.join(OUTPUT_DIR, f)) // 1024
            print(f"  {f}  ({size_kb} KB)")


if __name__ == "__main__":
    main()
