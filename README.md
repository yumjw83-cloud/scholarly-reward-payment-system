# XRPL 기반 학술저작물 저자 보상 자동 지급 시스템 — 재현성 패키지

박사학위논문 **「AI 학습데이터로 활용되는 학술저작물의 저자 보상 자동 지급 구조 설계 및 성능 평가」**(염정완, 숭실대학교, 2026) 제4장 실험의 재현성 패키지다.

- 학위논문 DOI / 기관 리포지토리: ［기입］
- 본 저장소 영구 보존 DOI (Zenodo 등): ［기입］
- 선행 연구: 염정완·전삼현(2025), 『지급결제학회지』 17(2), 419–437

> ⚠️ **측정값은 공용 XRPL Testnet 기준이며 Mainnet·컨소시엄 환경과 다를 수 있다.** 저자 식별자는 검증용 mock이고, ORCID·Hugging Face·CrossRef·IPFS(Pinata)·XRPL 연동은 실제 서비스 호출이다.
>
> ⚠️ **API 키·지갑 시드는 어떤 파일에도 포함되지 않는다.** 모두 환경변수로 주입된다.

---

## 1. 빠른 시작

```bash
git clone https://github.com/yumjw83-cloud/scholarly-reward-payment-system.git
cd scholarly-reward-payment-system

# Node.js 실험
npm install

# Python 추정·시각화·통계
pip install -r requirements.txt

# did:key E2E 증거 파일 압축 해제 (#13 재실행 시 필요)
unzip evidence.zip
```

**환경변수** — IPFS 업로드를 수행하는 두 스크립트만 필요하다.

```bash
export PINATA_JWT="본인이 발급한 토큰"   # https://pinata.cloud
```

ORCID·Hugging Face·CrossRef는 공개 API라 키가 필요 없다.

---

## 2. 실행 환경 (논문 [표 4-1])

| 항목 | 사양 |
|---|---|
| 실험 네트워크 | XRPL Testnet (`wss://s.altnet.rippletest.net:51233`) |
| 합의 프로토콜 | XRPL Consensus (UNL 기반) |
| 런타임 | Node.js v20 LTS (속성 기반 테스트는 v24.14.0), Python 3.10+ |
| 핵심 라이브러리 | `xrpl` v4.6, `@noble/secp256k1` v2, `node-fetch` v2, `form-data` / `numpy`, `matplotlib`, `scipy`, `pingouin` |
| 암호 프리미티브 | ECDSA P-256(오라클·속성테스트) · secp256k1(DID/VC) · Ed25519(did:key) · SHA-256 |
| 오프체인 저장 | Pinata Cloud IPFS (CIDv1 base32) |
| 외부 API | ORCID Public API v3.0, Hugging Face Datasets API, CrossRef API |
| 반복 수 | 에스크로 성능 n=100(모드별) / 동시부하 조건당 10회 / ORCID n=30 / HF n=20 |
| 측정 기간 | 2026년 4월 7일 ~ 7월 31일 (측정일 6일) |

> crypto-condition(PREIMAGE-SHA-256)은 별도 라이브러리 없이 16진 접두사(`A0258020…810120`)로 직접 구성한다.

---

## 3. 스크립트 ↔ 논문 대응

| # | 스크립트 | 실험 내용 | 출력 | 논문 위치 |
|---|---|---|---|---|
| 1 | `xrpl_escrow_experiment.js` | 에스크로 3모드(TIME·CONDITION·CANCEL) 지연시간 n=100 | `xrpl_results_{time,condition,cancel}.{csv,txt}` | **[표 4-11]** (4.3.2) |
| 2 | `oracle_trigger_experiment.js` | ConditionalPaymentTrigger 4시나리오 판정 (실 Testnet + CrossRef DOI 검증) | `oracle_trigger_results.{csv,txt}` | **[표 4-4]** (4.2.1) |
| 3 | `property_based_test.js` | 건전성·완전성 속성 기반 테스트 92,000건 | `property_based_test_results.{csv,txt}` | **[표 4-5]** (4.2.1) |
| 4 | `did_vc_mock.js` | DID/VC 생성·서명·3단계 변조 탐지 | `did_vc_results.txt`, `did_document.json`, `vc_document.json` | **[표 4-6]** (4.2.2) |
| 5 | `ipfs_pinata.js` | IPFS 업로드·CID 반환·SHA-256 앵커링 *(PINATA_JWT 필요)* | `ipfs_results.{json,txt}` | **[표 4-7]** (4.2.3) |
| 6 | `supplementary_test_orcid.mjs` | ORCID Public API 실연동 n=30 (실 DOI 4,115건 추출) | `orcid_test_result.json` | **[표 4-8]** (4.2.4) |
| 7 | `supplementary_test_hf_oracle.mjs` | Hugging Face Datasets API 오라클 이벤트 소스 n=20 | `hf_oracle_test_result.json` | **[표 4-9]** (4.2.4) |
| 8 | `integration_test.js` | E2E 통합 (Phase1 DID/VC·IPFS → Phase2 CONDITION 에스크로) n=100 *(PINATA_JWT 필요)* | `integration_results.{csv,txt}` | **[표 4-13]** (4.3.2) |
| 9 | `concurrent_load_experiment.js` / `_ext.js` | 동시 제출 1~100 부하 (총 2,560건) | `concurrent_load_results{,_ext}.{csv,txt}`, `…_summary{,_ext}.csv` | **[표 4-14]** (4.3.2) |
| 10 | `storage_measurement_experiment_v2.js` | TIME·CONDITION 양 모드 × Memo 유무 저장 크기 실측 n=100 | `storage_measurement_results_v2.csv`, `…_summary_v2.txt` | 4.1.5 · 4.3.2 실측 |
| 11 | `condition_mismatch_test.js` | Condition 불일치 Fulfillment 거부 검증 + 정상 대조군 (각 5회) | `condition_mismatch_results.{csv,txt}` | 4.2.1 (본문 서술) · 부록 A.8 |
| 12 | `storage_poisson.py` | 시나리오별 저장량 $G_{chain}$·TPS $\lambda$·포화·민감도 | `storage_results.csv`, `storage_tps_results.csv` | **[표 4-16~4-19]** (4.3.3~4.3.5) |
| 13 | `index_final_enhanced.js` | did:key(Ed25519)+ORCID VC+CrossRef+에스크로 통합 E2E 100회 | `evidence/run_001~100/*`, `xrpl_results_enhanced.csv` | 4.2.4 통합 실증 · 부록 A.7 |
| 14 | `통계검정_재현.py` / `_pingouin.py` | CONDITION vs TIME EscrowFinish 지연 차이 검정 재현 | 표준 출력 | **[표 4-12]** (4.3.2) |
| 15 | `visualize.py` | 결과 시각화 | `figures/Fig1~5*.png` | 4.3절 그림 |
| — | `storage_measurement_experiment.js` | 저장 크기 실측 **v1** (TIME 모드만) — #10으로 대체됨 | `storage_measurement_results.csv`, `…_summary.txt` | 이력 보존용 |

### 실행 예시

```bash
node xrpl_escrow_experiment.js              # 1) 모드별 지연 (MODE 상수를 time/condition/cancel로 변경해 3회 실행)
node oracle_trigger_experiment.js           # 2) 트리거 판정
node property_based_test.js                 # 3) PBT 92,000건 (약 20초, 네트워크 불필요)
node did_vc_mock.js                         # 4) DID/VC (네트워크 불필요)
PINATA_JWT="..." node ipfs_pinata.js        # 5)
node supplementary_test_orcid.mjs           # 6)
node supplementary_test_hf_oracle.mjs       # 7)
PINATA_JWT="..." node integration_test.js   # 8) E2E
node concurrent_load_experiment.js          # 9)
node storage_measurement_experiment_v2.js   # 10)
node condition_mismatch_test.js             # 11)
python3 storage_poisson.py                  # 12) 추정 (네트워크 불필요, 항상 동일 결과)
node index_final_enhanced.js                # 13) did:key E2E
python3 통계검정_재현_pingouin.py            # 14) 통계 재현
python3 visualize.py                        # 15) 그림 (CSV 선행 필요)
```

> 스크립트는 모두 **현재 작업 디렉터리 기준**으로 파일을 읽고 쓴다(`evidence/`·`figures/`만 하위 폴더). 저장소 루트에서 실행할 것. 파일을 하위 폴더로 재배치하면 동작하지 않는다.

---

## 4. ⚠️ 재현 실행 시 주의

### 4-1. 출력 파일을 덮어쓴다

Testnet 실험 스크립트는 `fs.writeFileSync`로 결과 파일을 **덮어쓴다.** 동봉된 CSV·TXT는 **논문 보고 수치의 원본**이므로, 재실행 전 백업할 것.

```bash
mkdir -p _original && cp *.csv *.txt _original/
```

### 4-2. 재실행하면 다른 값이 나온다

공용 Testnet의 지연시간은 트래픽·Faucet 상태에 따라 변동한다. **절대값 재현은 보장되지 않는다.** 기능 판정(#2·#3·#4·#5·#11)과 추정(#12)은 결정론적으로 재현된다.

| 성질 | 스크립트 |
|---|---|
| **결정론적 재현** | #3 PBT · #4 DID/VC · #11 Condition 거부 · #12 저장량 추정 · #14 통계 재현 |
| **지연시간 변동** | #1 · #2 · #8 · #9 · #10 · #13 |
| **크기는 결정론적** | #10 — 바이너리 인코딩이 결정론적이라 SD=0 |

### 4-3. 논문 수치 검증은 재집계로 하라

논문 표의 값을 확인하려면 스크립트를 재실행하지 말고 **동봉된 원시 데이터를 재집계**하는 것이 정확하다.

```bash
python3 통계검정_재현_pingouin.py   # xrpl_results_{condition,time}.csv 앞 100행 사용
```

통계 요약값은 **표본 표준편차(n−1)·선형보간 백분위수**를 사용한다. `concurrent_load_experiment.js`의 `sampleStdDev`·`percentileLinear` 함수가 논문 [표 4-14]와 동일한 정의다.

---

## 5. 주요 결과 요약

| 항목 | 값 | 논문 |
|---|---|---|
| 에스크로 3모드 성공률 | 100/100 (전 모드) | [표 4-11] |
| CONDITION `EscrowCreate` / `EscrowFinish` | 6,345.7 / 6,047.7 ms | [표 4-11] |
| 수수료 | `EscrowCreate` 12 drops / 조건부 `EscrowFinish` 423 drops | 4.1.3 |
| Algorithm 1 4시나리오 | 정상 10/10 · 거부 각 3/3 | [표 4-4] |
| 속성 기반 테스트 | 92,000건, 반례 0 | [표 4-5] |
| Condition 불일치 거부 | 5/5 `tecCRYPTOCONDITION_ERROR` (대조군 5/5 `tesSUCCESS`) | 4.2.1 |
| ORCID 실연동 | 30/30, DOI 4,115건 | [표 4-8] |
| Hugging Face | 20/20, 평균 255 ms | [표 4-9] |
| E2E 통합 (Phase1/Create/Finish) | 3,376.8 / 6,188.3 / 6,204.0 ms | [표 4-13] |
| 동시 부하 | 1~100 전 구간 2,560건 무실패 | [표 4-14] |
| 저장 크기 (TIME / CONDITION) | 188·636 B / 230·678 B (모두 SD=0) | 4.1.5 |
| did:key E2E | 100/100 성공 | 4.2.4 |

---

## 6. 데이터 파일 안내

| 분류 | 파일 |
|---|---|
| 지연시간·부하 | `xrpl_results_*.csv`, `integration_results.csv`, `concurrent_load_*.csv` |
| 기능 검증 | `oracle_trigger_results.*`, `property_based_test_results.*`, `did_vc_results.txt`, `condition_mismatch_results.*` |
| 저장·앵커링 | `ipfs_results.json`, `storage_measurement_results_v2.csv`, `storage_results.csv`, `storage_tps_results.csv` |
| 외부 API | `orcid_test_result.json`, `hf_oracle_test_result.json` |
| DID/VC 산출물 | `did_document.json`, `vc_document.json`, `vc_hashes.json` |
| did:key E2E 증거 | `evidence.zip` — 압축 해제 시 `evidence/run_001~100/` (실행별 DID·VC·CrossRef 응답·트랜잭션 해시, JSON 600개) |
| 그림 | `figures/Fig1~5*.png` |

> `storage_measurement_summary.txt`(v1) 상단에는 비교 기준에 관한 정정 안내가 있다. 해당 파일의 하단 비교값은 $s_{event}$(1,024 B) 기준이며, 논문의 비교 기준은 $s_e + s_u$(640 B)다. 정정된 비교는 `storage_measurement_summary_v2.txt`를 따른다.

---

## 7. 한계

1. **Testnet 한정** — Mainnet·사설 UNL 컨소시엄과 수수료·지연시간이 다를 수 있다. 실제 배포 타깃은 허가형 컨소시엄이며, 본 측정은 보수적(상한) 추정으로 본다.
2. **mock 범위** — 저자 신원 바인딩(테스트 DID)·라이브 AI 학습 파이프라인 연속 수신·Mainnet 실자산은 본 패키지 범위 밖이다. 그 외 암호·DOI(CrossRef)·식별(ORCID)·이벤트 소스(HF)·저장(IPFS)·집행(에스크로)은 실제 서비스 호출이다.
3. **온체인 레코드 구현 범위** — 논문 [표 3-13]의 9종 레코드 중 실제 XRPL 기록은 ①(에스크로 트랜잭션)과 Memo로 앵커링된 ⑤(이벤트)에 한정된다. ②~④·⑥~⑨는 해시 산출 및 인메모리 상태 저장소 시뮬레이션 수준이다.
4. **보안** — 본 저장소에 API 키·지갑 시드는 포함되지 않는다. 포크·기여 시에도 커밋하지 말 것(`.gitignore` 참조).

---

## 8. 인용

```
염정완. (2026). AI 학습데이터로 활용되는 학술저작물의 저자 보상 자동 지급 구조
설계 및 성능 평가 [박사학위논문, 숭실대학교]. ［리포지토리 URL］
```

`CITATION.cff`에 기계 판독 가능한 인용 정보가 있다.

## 9. 라이선스

- **코드**: MIT
- **실험 데이터·그림**: CC BY 4.0
- **특허 고지**: 본 저장소가 구현하는 조건부 자동 지급 구조는 특허 출원되었다(10-2026-0132901, 출원인 숭실대학교 산학협력단). MIT 라이선스는 특허권 실시를 허락하지 않는다.

상세는 `LICENSE` 참조.
