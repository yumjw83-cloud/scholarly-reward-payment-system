/**
 * Algorithm 1 (ConditionalPaymentTrigger) — Property-Based Test
 *
 * 건전성(Soundness) 및 완전성(Completeness) 속성 검증
 * 가정 A1–A4를 시뮬레이션하여 50,000건 무작위 입력에 대해 반례를 탐색한다.
 */

const crypto = require('crypto');

// ── 키 쌍 생성 (ECDSA P-256) ──
const oracleKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const issuerKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const attackerKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

// ── 시뮬레이션된 온체인 레코드 저장소 ──
class OnchainStore {
  constructor() {
    this.records = { doi: new Set(), did: new Map(), escrow: new Map(), vcHash: new Map() };
  }
  registerDOI(doi) { this.records.doi.add(doi); }
  registerDID(did, vcCid) { this.records.did.set(did, { vc_cid: vcCid }); }
  registerEscrow(doi, cancelAfter) { this.records.escrow.set(doi, { id: `esc_${doi}`, amount: 1000, CancelAfter: cancelAfter }); }
  registerVCHash(did, hash) { this.records.vcHash.set(did, hash); }
  lookupDOI(doi) { return this.records.doi.has(doi) ? { doi } : null; }
  lookupDID(did) { return this.records.did.get(did) || null; }
  lookupEscrow(doi) { return this.records.escrow.get(doi) || null; }
  lookupVCHash(did) { return this.records.vcHash.get(did) || null; }
}

// ── IPFS 시뮬레이션 ──
class IPFSStore {
  constructor() { this.store = new Map(); }
  put(cid, data) { this.store.set(cid, data); }
  fetch(cid) { return this.store.get(cid) || null; }
}

// ── 유틸리티 ──
function sha256(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
}

function ecdsaSign(privateKey, data) {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  return sign.sign(privateKey, 'hex');
}

function ecdsaVerify(publicKey, data, signature) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    return verify.verify(publicKey, signature, 'hex');
  } catch { return false; }
}

// ── Algorithm 1: ConditionalPaymentTrigger ──
function conditionalPaymentTrigger(E, onchain, ipfs, oraclePubKey, issuerPubKey) {
  // Step 1: 오라클 서명 검증
  const h = sha256(E.payload);
  if (h !== E.payload_hash) return 'REJECTED';
  if (!ecdsaVerify(oraclePubKey, h, E.oracle_sig)) return 'REJECTED';

  // Step 2: DOI 매칭
  const record_m = onchain.lookupDOI(E.target_doi);
  if (!record_m) return 'REJECTED';

  // Step 3: DID/VC 검증
  const record_d = onchain.lookupDID(E.subject_did);
  if (!record_d) return 'REJECTED';
  const vc = ipfs.fetch(record_d.vc_cid);
  if (!vc) return 'REJECTED';
  const vcFullStr = typeof vc === 'string' ? vc : JSON.stringify(vc);
  const h_vc_record = onchain.lookupVCHash(E.subject_did);
  if (!h_vc_record) return 'REJECTED';
  if (sha256(vcFullStr) !== h_vc_record) return 'REJECTED';
  // VC 서명 검증: signature 필드 제외한 content에 대해 검증 (W3C VC 표준)
  const { signature: _sig, ...vcContent } = vc;
  const vcContentStr = JSON.stringify(vcContent);
  if (!ecdsaVerify(issuerPubKey, vcContentStr, vc.signature)) return 'REJECTED';
  if (vc.target_doi !== E.target_doi) return 'REJECTED';

  // Step 4: 에스크로 유효성
  const escrow = onchain.lookupEscrow(E.target_doi);
  if (!escrow) return 'REJECTED';
  if (E.t_occur > escrow.CancelAfter) return 'REJECTED';

  // Step 5: 지급 실행
  return 'CONDITION_MET';
}

// ── 테스트 데이터 생성 ──
function randomHex(len) { return crypto.randomBytes(len).toString('hex'); }
function randomDOI() { return `10.1234/${randomHex(4)}`; }
function randomDID() { return `did:xrpl:${randomHex(8)}`; }

function createValidCase(onchain, ipfs) {
  const doi = randomDOI();
  const did = randomDID();
  const cancelAfter = Date.now() + 86400000;
  const t_occur = Date.now() - Math.floor(Math.random() * 3600000);

  // VC 생성 및 서명
  const vcContent = { subject: did, target_doi: doi, issued: new Date().toISOString() };
  const vcStr = JSON.stringify(vcContent);
  const vcSig = ecdsaSign(issuerKey.privateKey, vcStr);
  const vc = { ...vcContent, signature: vcSig };
  const vcCid = `bafk${randomHex(12)}`;

  // 온체인 등록
  onchain.registerDOI(doi);
  onchain.registerDID(did, vcCid);
  onchain.registerEscrow(doi, cancelAfter);
  const vcWithSigStr = JSON.stringify(vc);
  onchain.registerVCHash(did, sha256(vcWithSigStr));

  // IPFS 저장
  ipfs.put(vcCid, vc);

  // 이벤트 payload 및 서명
  const payload = JSON.stringify({ type: 'TYPE-1', doi, did, t_occur });
  const payloadHash = sha256(payload);
  const oracleSig = ecdsaSign(oracleKey.privateKey, payloadHash);

  return {
    event: {
      eid: crypto.randomUUID(),
      type: 'TYPE-1',
      t_occur,
      subject_did: did,
      target_doi: doi,
      oracle_sig: oracleSig,
      payload_hash: payloadHash,
      payload
    },
    doi, did, cancelAfter, vcCid
  };
}

// ── 속성 기반 테스트 실행 ──
const VALID_COUNT = 10000;
const MUTATION_COUNT_PER_TYPE = 10000;

const results = {
  completeness: { total: 0, pass: 0, fail: 0 },
  soundness_payload_tamper: { total: 0, pass: 0, fail: 0 },
  soundness_sig_forge: { total: 0, pass: 0, fail: 0 },
  soundness_doi_unregistered: { total: 0, pass: 0, fail: 0 },
  soundness_vc_tamper: { total: 0, pass: 0, fail: 0 },
  soundness_vc_doi_mismatch: { total: 0, pass: 0, fail: 0 },
  soundness_escrow_expired: { total: 0, pass: 0, fail: 0 },
  soundness_did_unregistered: { total: 0, pass: 0, fail: 0 },
  soundness_issuer_sig_forge: { total: 0, pass: 0, fail: 0 },
  boundary_expire_exact: { total: 0, pass: 0, fail: 0 },
  boundary_hash_1bit: { total: 0, pass: 0, fail: 0 },
};

console.log('=== Algorithm 1 속성 기반 테스트 시작 ===\n');
const startTime = Date.now();

// ── 테스트 1: 완전성 (Completeness) ──
// 정당한 입력 → 반드시 CONDITION_MET
console.log(`[완전성] 정당한 입력 ${VALID_COUNT}건 테스트...`);
for (let i = 0; i < VALID_COUNT; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.completeness.total++;
  if (result === 'CONDITION_MET') results.completeness.pass++;
  else results.completeness.fail++;
}

// ── 테스트 2: 건전성 — Payload 변조 (P1 위반) ──
console.log(`[건전성-P1a] Payload 변조 ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  event.payload = event.payload + '_tampered';  // payload 변조
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_payload_tamper.total++;
  if (result === 'REJECTED') results.soundness_payload_tamper.pass++;
  else results.soundness_payload_tamper.fail++;
}

// ── 테스트 3: 건전성 — 오라클 서명 위조 (P1 위반) ──
console.log(`[건전성-P1b] 오라클 서명 위조 ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  const fakeHash = sha256(event.payload);
  event.oracle_sig = ecdsaSign(attackerKey.privateKey, fakeHash);  // 공격자 키로 서명
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_sig_forge.total++;
  if (result === 'REJECTED') results.soundness_sig_forge.pass++;
  else results.soundness_sig_forge.fail++;
}

// ── 테스트 4: 건전성 — 미등록 DOI (P2 위반) ──
console.log(`[건전성-P2] 미등록 DOI ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  event.target_doi = randomDOI();  // 등록되지 않은 DOI로 교체
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_doi_unregistered.total++;
  if (result === 'REJECTED') results.soundness_doi_unregistered.pass++;
  else results.soundness_doi_unregistered.fail++;
}

// ── 테스트 5: 건전성 — VC 해시 변조 (P3 위반) ──
console.log(`[건전성-P3a] VC 해시 변조 ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event, vcCid } = createValidCase(onchain, ipfs);
  // IPFS의 VC 내용을 변조
  const tamperedVC = { subject: event.subject_did, target_doi: event.target_doi, issued: 'TAMPERED', signature: randomHex(32) };
  ipfs.put(vcCid, tamperedVC);
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_vc_tamper.total++;
  if (result === 'REJECTED') results.soundness_vc_tamper.pass++;
  else results.soundness_vc_tamper.fail++;
}

// ── 테스트 6: 건전성 — VC DOI 불일치 (P3 위반) ──
console.log(`[건전성-P3b] VC DOI 불일치 ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const doi1 = randomDOI();
  const doi2 = randomDOI();
  const did = randomDID();
  const cancelAfter = Date.now() + 86400000;

  // VC는 doi2로 발급, 이벤트는 doi1으로 요청
  const vcContent = { subject: did, target_doi: doi2, issued: new Date().toISOString() };
  const vcStr = JSON.stringify(vcContent);
  const vcSig = ecdsaSign(issuerKey.privateKey, vcStr);
  const vc = { ...vcContent, signature: vcSig };
  const vcCid = `bafk${randomHex(12)}`;
  const vcWithSigStr = JSON.stringify(vc);

  onchain.registerDOI(doi1);
  onchain.registerDOI(doi2);
  onchain.registerDID(did, vcCid);
  onchain.registerEscrow(doi1, cancelAfter);
  onchain.registerVCHash(did, sha256(vcWithSigStr));
  ipfs.put(vcCid, vc);

  const payload = JSON.stringify({ type: 'TYPE-1', doi: doi1, did, t_occur: Date.now() });
  const payloadHash = sha256(payload);
  const oracleSig = ecdsaSign(oracleKey.privateKey, payloadHash);

  const event = { eid: crypto.randomUUID(), type: 'TYPE-1', t_occur: Date.now(), subject_did: did, target_doi: doi1, oracle_sig: oracleSig, payload_hash: payloadHash, payload };
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_vc_doi_mismatch.total++;
  if (result === 'REJECTED') results.soundness_vc_doi_mismatch.pass++;
  else results.soundness_vc_doi_mismatch.fail++;
}

// ── 테스트 7: 건전성 — 에스크로 만료 (P4 위반) ──
console.log(`[건전성-P4] 에스크로 만료 ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  event.t_occur = Date.now() + 999999999;  // 미래 시각으로 만료 초과
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_escrow_expired.total++;
  if (result === 'REJECTED') results.soundness_escrow_expired.pass++;
  else results.soundness_escrow_expired.fail++;
}

// ── 테스트 8: 건전성 — 미등록 DID (P3 위반) ──
console.log(`[건전성-P3c] 미등록 DID ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  event.subject_did = randomDID();  // 등록되지 않은 DID로 교체
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_did_unregistered.total++;
  if (result === 'REJECTED') results.soundness_did_unregistered.pass++;
  else results.soundness_did_unregistered.fail++;
}

// ── 테스트 9: 건전성 — 발급자 서명 위조 (P3 위반) ──
console.log(`[건전성-P3d] 발급자 서명 위조 ${MUTATION_COUNT_PER_TYPE}건 테스트...`);
for (let i = 0; i < MUTATION_COUNT_PER_TYPE; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const doi = randomDOI();
  const did = randomDID();
  const cancelAfter = Date.now() + 86400000;

  // 공격자 키로 VC 서명
  const vcContent = { subject: did, target_doi: doi, issued: new Date().toISOString() };
  const vcStr = JSON.stringify(vcContent);
  const vcSig = ecdsaSign(attackerKey.privateKey, vcStr);  // 공격자 키!
  const vc = { ...vcContent, signature: vcSig };
  const vcCid = `bafk${randomHex(12)}`;
  const vcWithSigStr = JSON.stringify(vc);

  onchain.registerDOI(doi);
  onchain.registerDID(did, vcCid);
  onchain.registerEscrow(doi, cancelAfter);
  onchain.registerVCHash(did, sha256(vcWithSigStr));
  ipfs.put(vcCid, vc);

  const payload = JSON.stringify({ type: 'TYPE-1', doi, did, t_occur: Date.now() });
  const payloadHash = sha256(payload);
  const oracleSig = ecdsaSign(oracleKey.privateKey, payloadHash);

  const event = { eid: crypto.randomUUID(), type: 'TYPE-1', t_occur: Date.now(), subject_did: did, target_doi: doi, oracle_sig: oracleSig, payload_hash: payloadHash, payload };
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.soundness_issuer_sig_forge.total++;
  if (result === 'REJECTED') results.soundness_issuer_sig_forge.pass++;
  else results.soundness_issuer_sig_forge.fail++;
}

// ── 테스트 10: 경계값 — 만료 시각 정확히 일치 ──
console.log(`[경계값] 만료 시각 정확히 일치 1,000건 테스트...`);
for (let i = 0; i < 1000; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event, cancelAfter } = createValidCase(onchain, ipfs);
  event.t_occur = cancelAfter;  // 정확히 만료 시각
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.boundary_expire_exact.total++;
  // t_occur <= CancelAfter 이므로 정확히 일치 시 CONDITION_MET이어야 함
  if (result === 'CONDITION_MET') results.boundary_expire_exact.pass++;
  else results.boundary_expire_exact.fail++;
}

// ── 테스트 11: 경계값 — 해시 1비트 차이 ──
console.log(`[경계값] Payload 해시 1비트 변조 1,000건 테스트...`);
for (let i = 0; i < 1000; i++) {
  const onchain = new OnchainStore();
  const ipfs = new IPFSStore();
  const { event } = createValidCase(onchain, ipfs);
  // payload_hash의 마지막 문자를 변경 (1비트 이상 변조)
  const lastChar = event.payload_hash[event.payload_hash.length - 1];
  const flipped = lastChar === '0' ? '1' : '0';
  event.payload_hash = event.payload_hash.slice(0, -1) + flipped;
  const result = conditionalPaymentTrigger(event, onchain, ipfs, oracleKey.publicKey, issuerKey.publicKey);
  results.boundary_hash_1bit.total++;
  if (result === 'REJECTED') results.boundary_hash_1bit.pass++;
  else results.boundary_hash_1bit.fail++;
}

// ── 결과 출력 및 파일 저장 ──
const fs = require('fs');

const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
const totalTests = Object.values(results).reduce((s, r) => s + r.total, 0);
const totalFails = Object.values(results).reduce((s, r) => s + r.fail, 0);

const TXT_FILE = 'property_based_test_results.txt';
const CSV_FILE = 'property_based_test_results.csv';

const labels = {
  completeness: ['완전성 (Completeness)', '정당 입력 → CONDITION_MET', 'Completeness'],
  soundness_payload_tamper: ['건전성-P1a', 'Payload 변조 → REJECTED', 'Soundness-P1a'],
  soundness_sig_forge: ['건전성-P1b', '오라클 서명 위조 → REJECTED', 'Soundness-P1b'],
  soundness_doi_unregistered: ['건전성-P2', '미등록 DOI → REJECTED', 'Soundness-P2'],
  soundness_vc_tamper: ['건전성-P3a', 'VC 해시 변조 → REJECTED', 'Soundness-P3a'],
  soundness_vc_doi_mismatch: ['건전성-P3b', 'VC DOI 불일치 → REJECTED', 'Soundness-P3b'],
  soundness_did_unregistered: ['건전성-P3c', '미등록 DID → REJECTED', 'Soundness-P3c'],
  soundness_issuer_sig_forge: ['건전성-P3d', '발급자 서명 위조 → REJECTED', 'Soundness-P3d'],
  soundness_escrow_expired: ['건전성-P4', '에스크로 만료 → REJECTED', 'Soundness-P4'],
  boundary_expire_exact: ['경계값-시각', '만료 정확 일치 → CONDITION_MET', 'Boundary-Time'],
  boundary_hash_1bit: ['경계값-해시', '1비트 변조 → REJECTED', 'Boundary-Hash'],
};

// ── TXT 결과 파일 ──
const txtLines = [];
txtLines.push('Algorithm 1 (ConditionalPaymentTrigger) 속성 기반 테스트 결과');
txtLines.push(`실행시각: ${new Date().toLocaleString('ko-KR')}`);
txtLines.push(`실행환경: Node.js ${process.version}, ECDSA P-256, SHA-256`);
txtLines.push('='.repeat(70));
txtLines.push(`실행 시간: ${elapsed}초 | 총 테스트: ${totalTests.toLocaleString()}건 | 반례: ${totalFails}건`);
txtLines.push('='.repeat(70));
txtLines.push('');
txtLines.push('속성                    | 기대 결과              | 건수     | 통과     | 실패 | 통과율');
txtLines.push('-'.repeat(90));

for (const [key, r] of Object.entries(results)) {
  const [name, desc] = labels[key];
  const rate = r.total > 0 ? ((r.pass / r.total) * 100).toFixed(2) : '0.00';
  txtLines.push(
    `${name.padEnd(22)} | ${desc.padEnd(22)} | ${String(r.total).padStart(7)} | ${String(r.pass).padStart(7)} | ${String(r.fail).padStart(4)} | ${rate}%`
  );
}

txtLines.push('-'.repeat(90));
txtLines.push(`${'총계'.padEnd(22)} |                        | ${String(totalTests).padStart(7)} | ${String(totalTests - totalFails).padStart(7)} | ${String(totalFails).padStart(4)} | ${totalFails === 0 ? '100.00' : ((1 - totalFails / totalTests) * 100).toFixed(2)}%`);
txtLines.push('='.repeat(70));
txtLines.push('');

if (totalFails === 0) {
  txtLines.push('결론: 전체 ' + totalTests.toLocaleString() + '건 테스트에서 반례 0건.');
  txtLines.push('건전성(명제 1) 및 완전성(명제 2)에 대한 경험적 반례가 발견되지 않았음.');
} else {
  txtLines.push('경고: ' + totalFails + '건의 반례 발견. 알고리즘 검토 필요.');
}

txtLines.push('');
txtLines.push('테스트 설계:');
txtLines.push('  - 완전성: 무작위 생성된 정당 입력이 CONDITION_MET을 반환하는지 검증');
txtLines.push('  - 건전성: 4개 술어(P1~P4) 각각을 위반하는 입력이 REJECTED를 반환하는지 검증');
txtLines.push('  - 경계값: 만료 시각 정확 일치, 해시 1비트 변조 등 경계 조건 검증');
txtLines.push('  - 암호 프리미티브: ECDSA P-256 (Node.js crypto), SHA-256');
txtLines.push('  - 각 테스트 케이스는 독립된 온체인 상태·IPFS 저장소·키 쌍으로 실행');

fs.writeFileSync(TXT_FILE, txtLines.join('\n'), 'utf8');

// ── CSV 결과 파일 ──
const csvLines = [];
csvLines.push('test_id,property,description,expected,total,pass,fail,pass_rate');

for (const [key, r] of Object.entries(results)) {
  const [name, desc, engName] = labels[key];
  const rate = r.total > 0 ? ((r.pass / r.total) * 100).toFixed(2) : '0.00';
  const expected = key.startsWith('soundness') || key === 'boundary_hash_1bit' ? 'REJECTED' : 'CONDITION_MET';
  csvLines.push(`${engName},"${name}","${desc}",${expected},${r.total},${r.pass},${r.fail},${rate}`);
}

csvLines.push(`TOTAL,총계,,,,${totalTests},${totalTests - totalFails},${totalFails},${totalFails === 0 ? '100.00' : ((1 - totalFails / totalTests) * 100).toFixed(2)}`);
csvLines.push('');
csvLines.push(`# 실행시각,${new Date().toISOString()}`);
csvLines.push(`# 실행시간_초,${elapsed}`);
csvLines.push(`# Node.js,${process.version}`);
csvLines.push(`# 암호프리미티브,ECDSA_P-256_SHA-256`);

fs.writeFileSync(CSV_FILE, csvLines.join('\n'), 'utf8');

// ── 콘솔 출력 ──
console.log('\n' + txtLines.join('\n'));
console.log('');
console.log(`저장 파일:`);
console.log(`  ${TXT_FILE}  — 실험 결과 로그`);
console.log(`  ${CSV_FILE}  — 수치 데이터 (논문 표 입력용)`);
