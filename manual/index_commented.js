// ═══════════════════════════════════════════════════════════════════════════
//  Claude ↔ Slack 브릿지 봇 (한국어 주석 버전)
// ═══════════════════════════════════════════════════════════════════════════
//
//  이 파일은 Node.js(자바스크립트 실행기)로 돌아가는 봇 프로그램입니다.
//
//  이 봇이 하는 일:
//    1. Slack 에서 유저가 /claude 같은 명령을 입력하면 Anthropic API 로
//       Claude 에게 작업을 시키고 결과를 Slack 에 다시 올려줍니다.
//    2. tmux 라는 터미널 멀티플렉서 안에서 돌아가는 Claude Code 에
//       Slack 에서 명령을 보내고, Claude Code 가 권한 요청을 할 때마다
//       Slack 에 "허용할까요?" 버튼을 띄워줍니다.
//
//  JS 기본 문법 요약 (모르면 여기 먼저 보세요):
//    - const X = ... : 상수 선언. 한 번 값을 정하면 바꿀 수 없음.
//    - let   X = ... : 변수 선언. 나중에 값을 바꿀 수 있음.
//    - function 이름(매개변수) { ... } : 함수(= 재사용 가능한 작업 덩어리) 정의
//    - async function / await : "기다려야 하는 작업"을 다루는 문법.
//           네트워크 호출이나 파일 입출력처럼 시간이 걸리는 일을
//           처리할 때 "await" 라고 붙이면 "끝날 때까지 기다렸다가 다음 줄로 가"
//    - (인자) => { ... } : 화살표 함수. function 을 짧게 쓴 것.
//    - { a, b } = obj    : "구조 분해". obj 에서 a, b 필드만 꺼내 변수로 씀.
//    - `문자열 ${x}`     : 백틱 문자열. 안에 ${변수} 쓰면 값이 끼워넣어짐.
//    - /.../             : 정규식. 문자열에서 패턴을 찾는 도구.
//
// ═══════════════════════════════════════════════════════════════════════════


// ─── 1단계: 필요한 라이브러리(남이 만들어둔 코드 묶음) 불러오기 ────────────────
// require("...") 는 다른 코드 묶음을 가져오는 명령입니다.
// npm install 로 설치한 패키지들을 여기서 불러와 사용합니다.

const { App } = require("@slack/bolt");
//   @slack/bolt 는 Slack 봇을 쉽게 만들게 해주는 공식 라이브러리입니다.
//   그 안에서 "App" 이라는 클래스(객체 설계도)만 꺼내 씁니다.

const Anthropic = require("@anthropic-ai/sdk");
//   Anthropic(Claude 를 만든 회사)의 공식 라이브러리. Claude 에게 질문을 보낼 때 씁니다.

const dotenv = require("dotenv");
//   .env 파일(비밀번호·API 키 등이 들어있는 파일)을 읽어서
//   환경변수로 만들어주는 라이브러리.

const fs = require("fs");
//   "File System"의 약자. Node.js 기본 내장 기능으로, 파일을 읽고 쓰는 데 씁니다.

const path = require("path");
//   파일 경로(예: "/home/user/test.txt")를 다루는 기본 내장 기능.

const { execSync } = require("child_process");
//   "child_process" = 다른 프로그램(셸 명령어 등)을 실행하는 기본 기능.
//   execSync 는 그 중에서 "명령어를 실행하고 결과를 받을 때까지 기다려 주는" 함수.


// ─── 2단계: .env 파일 읽기 ────────────────────────────────────────────────────
dotenv.config();
//   이 한 줄을 실행하면 프로젝트 폴더의 .env 파일에 적힌 값들이
//   process.env.XXX 로 접근 가능해집니다.
//   (.env 안에는 SLACK_BOT_TOKEN=xoxb-... 같은 게 들어있음)


// ─── 3단계: 사용할 Claude 모델 이름을 상수로 선언 ────────────────────────────
// 여기만 바꾸면 파일 전체에서 쓰는 모델이 한 번에 바뀝니다.
const MODEL = "claude-opus-4-6";


// ─── 4단계: Anthropic / Slack 클라이언트 만들기 ──────────────────────────────
// "클라이언트" = API 서버와 대화하는 연결 객체라고 생각하면 됩니다.

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
//   Anthropic API 서버에 접속할 수 있는 연결 객체를 만듭니다.
//   apiKey 는 .env 에서 가져온 비밀 키입니다.

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,   // Slack Bot 토큰 (xoxb-...)
  appToken: process.env.SLACK_APP_TOKEN, // Slack App 토큰 (xapp-...)
  socketMode: true,                      // 외부 URL 없이 WebSocket 으로 연결
});
//   Slack 봇 App 객체를 만듭니다. 이 app 에다 "이런 명령이 오면 이거 해라" 라고
//   나중에 이벤트 핸들러를 등록하게 됩니다.

const sessions = new Map();
//   Map = "키-값 쌍"을 저장하는 자료구조 (사전같이 생각하면 됨)
//   여기서는 "어떤 Slack 스레드에서 Claude 와 어떤 대화를 했는지" 를 기억하는 용도.


// ─── 5단계: tmux 상태를 기억할 변수들 ─────────────────────────────────────────
// tmux 는 "하나의 터미널 창 안에서 여러 세션을 관리할 수 있게 해주는 프로그램"
// 입니다. 이 봇은 이미 실행 중인 tmux 안의 Claude Code 를 지켜봅니다.

let currentTmuxSession = null;   // 지금 연결된 tmux 세션 번호/이름 (연결 안 됐으면 null)
let tmuxPollingActive  = false;  // "지금 tmux 를 3초마다 들여다보는 중인가?" 플래그
let tmuxStreamChannel  = null;   // 알림을 보낼 Slack 채널 ID
let tmuxStreamTs       = null;   // Slack 에서 스레드의 "뿌리 메시지" 타임스탬프(ID 역할)
let tmuxLiveMsgTs      = null;   // 실시간으로 업데이트하는 메시지의 타임스탬프 (사실상 현재는 쓰이지 않음)
let lastTmuxOutput     = "";     // 직전에 본 tmux 화면 내용 (중복 알림 방지용)
let awaitingPermission = false;  // "지금 권한 요청 대기 중인가?" 플래그


// ─── 6단계: "권한 요청 프롬프트" 를 감지하는 정규식 목록 ─────────────────────
// 정규식(/.../) 은 문자열에서 패턴을 찾는 규칙입니다.
// 예를 들어 /Do you want to proceed\?/i 는
// "Do you want to proceed?" 라는 글자가 들어있는지 찾는 규칙 (i = 대소문자 무시).
//
// tmux 안의 Claude Code 가 이런 문구를 화면에 띄우면
// "사용자 승인을 기다리고 있구나" 하고 봇이 눈치챌 수 있습니다.
const PERMISSION_PATTERNS = [
  /Do you want to proceed\?/i,
  /This command requires approval/i,
  /Allow this action\?/i,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /\[Y\/n\]/i,
  /1\.\s*Yes.*2\.\s*No/is,
  /Yes.*No.*\(enter number\)/is,
  /Allow Claude to/i,
  /Approve\?/i,
  /confirm.*\?/i,
  /Esc to cancel/i,
  /Tab to amend/i,
  /[❯›]\s*1\./,   // "❯ 1." 처럼 커서 마커 뒤에 번호가 나오는 패턴
];

// 위 패턴 목록 중 하나라도 output 문자열에 맞으면 true 를 돌려주는 함수.
// .some(콜백) 는 "배열 요소 중에 콜백이 true 를 돌려주는 게 하나라도 있으면 true".
// p.test(output) 은 "정규식 p 가 output 에 맞는지" 검사.
function detectPermissionRequest(output) {
  return PERMISSION_PATTERNS.some(p => p.test(output));
}


// ─── 7단계: 화면에서 "1. Yes / 2. No" 같은 번호 옵션 뽑아내기 ────────────────
//
// output: tmux 화면에서 잡아온 문자열
// 리턴값: { options: [{number:"1", label:"Yes"}, ...], parsed: true/false }
//         parsed=false 면 "파싱에 실패해서 Yes/No 로 대체했다" 는 뜻
function parseOptions(output) {
  // 1) "Do you want to proceed?" 가 나오는 위치를 찾습니다.
  //    search 가 위치(숫자)를 돌려주고, 못 찾으면 -1.
  const promptIndex = output.search(/Do you want to proceed\?/i);

  // 2) 찾았으면 그 위치 이후 문자열만, 못 찾았으면 전체 문자열을 검사 대상으로.
  //    3항 연산자: (조건) ? 참일때값 : 거짓일때값
  const relevant = promptIndex !== -1 ? output.slice(promptIndex) : output;

  // 3) 줄 시작(^)에서 "N. 내용" 꼴인 줄들을 모두 찾습니다.
  //    matchAll 은 매치된 것들을 반복자(iterator) 로 돌려주는데,
  //    [...iterator] 로 감싸면 배열로 펼쳐집니다.
  //    괄호() 부분은 "캡처 그룹" 이라서 m[1]=숫자, m[2]=내용 으로 꺼낼 수 있음.
  const matches = [...relevant.matchAll(/^[\s❯›]*([1-9])\.\s+(.+)/gm)];

  if (matches.length >= 2) {
    // 중복 번호 제거: 같은 번호가 여러 번 나오면 첫 번째만 취함.
    const seen   = new Set();  // Set = 중복 없는 목록
    const unique = [];
    for (const m of matches) {
      if (!seen.has(m[1])) {   // 아직 본 적 없는 번호면
        seen.add(m[1]);
        unique.push({ number: m[1], label: m[2].trim() });
      }
    }
    // 최소 2개 이상 있을 때만 "파싱 성공" 으로 인정
    if (unique.length >= 2) return { options: unique, parsed: true };
  }

  // 위 조건에 맞지 않으면 = 파싱 실패. 기본값 Yes/No 로 대체.
  return {
    options: [
      { number: "1", label: "Yes" },
      { number: "2", label: "No" },
    ],
    parsed: false,
  };
}


// ─── 8단계: 권한 요청용 Slack 메시지 블록 만들기 ──────────────────────────────
//
// Slack 에서 "버튼이 달린 예쁜 메시지" 를 보낼 때는 "blocks" 라는
// 자료 구조(객체들의 배열)를 넘겨야 합니다. 이 함수는 그 blocks 를 만들어 줍니다.
function buildPermissionBlocks(output) {
  const { options, parsed } = parseOptions(output);
  // 위 parseOptions 의 리턴값에서 options, parsed 두 필드만 꺼냅니다. (구조 분해)

  const ts = Date.now();
  // Date.now() 는 "1970년 1월 1일 이후 지난 밀리초". 고유한 숫자가 필요할 때 편함.
  // 같은 Slack 메시지 안에 action_id 가 중복되면 에러나서 시간값을 뒤에 붙여 유일하게 만듦.

  // options 배열의 각 원소를 "버튼 객체" 로 변환합니다.
  // .map(콜백) 은 "배열의 각 원소에 콜백 적용한 새 배열을 만든다".
  const buttons = options.map(opt => {
    const label = `${opt.number}. ${opt.label}`;        // "1. Yes" 같은 형태
    const truncated = label.length > 75                 // 75자 넘으면
      ? label.slice(0, 72) + "…"                        // 72자까지 자르고 … 붙임
      : label;
    return {
      type: "button",
      text: { type: "plain_text", text: truncated, emoji: true },
      // 라벨이 "no..." 로 시작하면 빨간색(danger), 아니면 녹색(primary)
      style: opt.label.toLowerCase().startsWith("no") ? "danger" : "primary",
      action_id: `tmux_option_${opt.number}_${ts}`,  // 메시지마다 고유한 ID
      value: opt.number,                              // 버튼 클릭 시 전달되는 값
    };
  });

  // 파싱 성공/실패에 따라 헤더 텍스트를 다르게 합니다.
  const headerText = parsed
    ? `⚠️ *Claude is requesting permission:*`
    : `⚠️ *Claude is requesting permission:*\n_⚠️ Could not parse options — showing default Yes/No. *Check terminal directly if more options exist.*_`;

  // 최종적으로 Slack 이 기대하는 blocks 배열을 반환.
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // output.slice(-600) 은 output 문자열의 뒤쪽 600자만 잘라냄 (마지막 화면만 보여주려고)
        text: `${headerText}\n\`\`\`\n${output.slice(-600)}\n\`\`\``,
      },
    },
    { type: "actions", elements: buttons },
  ];
}


// ─── 9단계: tmux 를 백그라운드에서 감시하는 함수 ──────────────────────────────
// async function 은 "await 를 쓸 수 있는 함수". 내부에서 await 로
// 오래 걸리는 작업을 기다리며 진행됩니다.
async function startTmuxPolling(client) {
  // 이미 감시 중이면 중복 시작 안 함
  if (tmuxPollingActive) return;

  tmuxPollingActive = true;
  lastTmuxOutput = "";
  awaitingPermission = false;

  // 이 변수들은 이 함수 안에서만 쓰는 로컬 변수
  let awaitingPermissionSince = null;  // 권한 대기 시작 시간 (리마인더용)
  let claudeWasWorking = false;        // (현재 미사용 - 구버전 흔적)
  let responseStartOutput = "";        // (현재 미사용 - 구버전 흔적)

  // 무한 루프. tmuxPollingActive 가 false 로 바뀌면 빠져나옴.
  while (tmuxPollingActive) {

    // 3초 기다림. setTimeout 을 Promise 로 감싸서 await 가능하게 만든 패턴.
    await new Promise(r => setTimeout(r, 3000));

    // 기다리는 동안 비활성화됐을 수도 있으니 다시 체크
    if (!tmuxPollingActive) break;

    // tmux 화면을 긁어오기 (에러 나면 루프 종료)
    let raw;
    try {
      raw = tmuxCapture();
    } catch {
      break;
    }

    // ANSI 이스케이프 코드(터미널 색상 제어 문자) 제거
    // \x1b 는 ESC 문자. 터미널 색깔·커서 움직임 등 제어 문자를 없애서 깨끗한 문자열로.
    const stripped = raw
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");

    // 앞뒤 공백 제거하고 마지막 8000자만 사용 (너무 길면 잘라냄)
    const output = stripped.trim().slice(-8000);

    // 권한 프롬프트가 사라졌다면 "대기 중" 상태 해제
    if (awaitingPermission && !detectPermissionRequest(output)) {
      awaitingPermission = false;
      awaitingPermissionSince = null;
    }

    // 5분(300,000ms) 지났는데도 응답 없으면 리마인더 재전송
    if (awaitingPermission && awaitingPermissionSince) {
      if (Date.now() - awaitingPermissionSince > 300000) {
        await client.chat.postMessage({
          channel: tmuxStreamChannel,
          thread_ts: tmuxStreamTs,
          text: "⏰ *Reminder — Claude is still waiting for your response:*",
          blocks: buildPermissionBlocks(lastTmuxOutput),
        });
        awaitingPermissionSince = Date.now();  // 시간 리셋
      }
    }

    // 화면 내용이 바뀌지 않았으면 이번 틱은 건너뜀 (continue)
    if (output === lastTmuxOutput) continue;
    lastTmuxOutput = output;

    // ────────────────────────────────────────────────────
    //  아래는 "응답 완료 자동 알림" 기능인데 false alarm 이 너무 많아서
    //  주석처리로 꺼둔 상태입니다. (실제로는 동작 안 함)
    // ────────────────────────────────────────────────────
    // const isWorking = /Thinking…|Crafting…|.../.test(output);
    // ... (생략)

    // 새로운 권한 요청이 감지되면 Slack 에 버튼 알림 보내기
    if (!awaitingPermission && detectPermissionRequest(output)) {
      awaitingPermission = true;
      awaitingPermissionSince = Date.now();

      // 이전 실시간 메시지가 있다면 내용 업데이트 (현재는 tmuxLiveMsgTs 가 쓰이지 않아 거의 안 탐)
      if (tmuxLiveMsgTs) {
        try {
          await client.chat.update({
            channel: tmuxStreamChannel,
            ts: tmuxLiveMsgTs,
            text: `\`\`\`\n${output.slice(-2800)}\n\`\`\``,
          });
        } catch {}
      }

      // 실제 버튼 달린 권한 요청 알림을 스레드에 올리기
      await client.chat.postMessage({
        channel: tmuxStreamChannel,
        thread_ts: tmuxStreamTs,
        text: "⚠️ Claude is requesting permission",
        blocks: buildPermissionBlocks(output),
      });
    }
  }
}


// ─── 10단계: 버튼 클릭 핸들러 (유저가 Slack 에서 "1. Yes" 등을 눌렀을 때) ─────
// app.action 은 "이 action_id 가 눌리면 아래 함수 실행" 이라고 등록하는 것.
// 첫 인자는 정규식: "tmux_option_" + 숫자 + "_" + 숫자 형태의 모든 action_id 매치.
app.action(/^tmux_option_(\d+)_\d+$/, async ({ body, ack, client, action }) => {
  await ack();
  // ack() = Slack 에 "네 클릭 이벤트 잘 받았어요" 라고 즉시 응답.
  // 3초 안에 ack 안 하면 Slack 이 "앱 응답 없음" 에러를 띄웁니다.

  if (!currentTmuxSession) return;  // tmux 연결 안 됐으면 무시

  const number = parseInt(action.value);  // 버튼 value("1","2","3"...)를 숫자로

  // "N번 선택" = Down 키를 (N-1)번 누르고 Enter
  // 예: 1번이면 그냥 Enter, 2번이면 Down 1번 + Enter, 3번이면 Down 2번 + Enter
  for (let i = 0; i < number - 1; i++) {
    execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} Down`);
    await new Promise(r => setTimeout(r, 150));  // 키 입력 사이 0.15초 쉼
  }
  execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} Enter`);

  awaitingPermission = false;  // 응답 완료 → 리마인더 중단

  // 원래 버튼 메시지를 "✅ Responded: option N" 으로 교체 (다시 누를 수 없게)
  try {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ *Responded: option ${number}*`,
      blocks: [],  // 빈 배열 = 버튼 제거
    });
  } catch {}
});


// ─── 11단계: /tmux-connect 슬래시 명령어 핸들러 ───────────────────────────────
// 유저가 Slack 에서 "/tmux-connect 0" 같이 치면 실행됨.
app.command("/tmux-connect", async ({ command, ack, client }) => {
  await ack();
  const sessionId = command.text.trim();  // "0" 같은 세션 번호

  // 인자 없으면 사용법 안내
  if (!sessionId) {
    await client.chat.postEphemeral({
      // postEphemeral = 본인에게만 보이는 임시 메시지 (다른 유저는 못 봄)
      channel: command.channel_id,
      user: command.user_id,
      text: "Usage: `/tmux-connect <session-index>`\nExample: `/tmux-connect 2`",
    });
    return;
  }

  // 해당 세션이 실제로 있는지 확인 (없으면 tmux 가 에러를 내고, 그걸 잡아서 안내)
  try {
    execSync(`tmux has-session -t ${sessionId}`);
  } catch {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `❌ tmux session \`${sessionId}\` not found. Run \`tmux ls\` to check.`,
    });
    return;
  }

  // 이전에 다른 세션 감시 중이었다면 멈추고 0.5초 대기
  tmuxPollingActive = false;
  await new Promise(r => setTimeout(r, 500));

  // 전역 상태 업데이트
  currentTmuxSession = sessionId;
  tmuxStreamChannel  = command.channel_id;
  awaitingPermission = false;

  // 앵커 메시지(이후 모든 알림이 이 메시지의 스레드 밑에 달림)를 올림
  const anchorMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🔗 *Connected to tmux session \`${sessionId}\`* — monitoring for permission requests.\nUse \`/tmux-status\` to see current output anytime.`,
  });
  tmuxStreamTs = anchorMsg.ts;  // 스레드의 기준 타임스탬프 저장

  // 연결 직후 현재 tmux 화면을 한 번 Slack 에 찍어줌
  try {
    const raw = tmuxCapture();
    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    const output = stripped.trim().slice(-2800);
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: tmuxStreamTs,
      text: `📺 *Current output:*\n\`\`\`\n${output}\n\`\`\``,
    });
    lastTmuxOutput = output;
  } catch {}

  // 3초마다 tmux 를 감시하는 백그라운드 루프 시작
  startTmuxPolling(client);
});


// ─── 12단계: /tmux-status — 연결된 세션의 현재 화면 보여주기 ──────────────────
app.command("/tmux-status", async ({ command, ack, client }) => {
  await ack();
  if (!currentTmuxSession) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Not connected to any tmux session. Use `/tmux-connect <session-index>` first.",
    });
    return;
  }
  try {
    const raw = tmuxCapture();
    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    const output = stripped.trim().slice(-2800);
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: tmuxStreamTs,
      text: `📺 *Current output:*\n\`\`\`\n${output}\n\`\`\``,
    });
  } catch (err) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `❌ Error: ${err.message}`,
    });
  }
});


// ─── 13단계: /tmux-disconnect — 연결 해제 ──────────────────────────────────────
app.command("/tmux-disconnect", async ({ command, ack, client }) => {
  await ack();
  tmuxPollingActive = false;   // 감시 루프 멈춤
  currentTmuxSession = null;   // 상태 초기화
  await client.chat.postMessage({
    channel: command.channel_id,
    text: "🔌 *Disconnected from tmux session.*",
  });
});


// ─── 14단계: /tmux — 연결된 세션에 텍스트 전송 ─────────────────────────────────
// 예: "/tmux ls" → tmux 세션에 "ls" 라고 입력된 것처럼 동작
app.command("/tmux", async ({ command, ack, client }) => {
  await ack();
  if (!currentTmuxSession) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Connect first with `/tmux-connect <session-index>`.",
    });
    return;
  }

  const input = command.text.trim();
  if (!input) return;

  awaitingPermission = false;  // 유저가 직접 뭔가 보냈으니 권한 대기 상태 해제
  tmuxSend(input);              // tmux 에 실제 키 전송

  await client.chat.postMessage({
    channel: command.channel_id,
    thread_ts: tmuxStreamTs,
    text: `⌨️ *Sent:* \`${input}\``,
  });
});


// ─── 15단계: 도우미(헬퍼) 함수들 ──────────────────────────────────────────────

// Slack 대화 맥락을 구분하기 위한 고유 키. 같은 스레드 = 같은 키.
function sessionKey(channelId, threadTs) {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

// 짧은 상태 메시지 보내기. mrkdwn: true 이면 Slack 마크다운 문법 해석해줌.
async function postStatus(client, channel, threadTs, text) {
  return client.chat.postMessage({ channel, thread_ts: threadTs, text, mrkdwn: true });
}

// 긴 텍스트를 maxLen 글자씩 여러 토막으로 잘라 배열로 돌려줌.
// Slack 은 한 메시지가 너무 길면 잘리므로 나눠 보낼 때 씀.
function chunkText(text, maxLen) {
  const chunks = [];
  while (text.length > maxLen) {
    chunks.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  chunks.push(text);
  return chunks;
}

// 결과 메시지 + "New Task"/"Exit Session" 버튼까지 같이 보냄.
async function postWithActions(client, channel, threadTs, text) {
  const chunks = chunkText(text, 2800);

  // 마지막 청크 빼고 먼저 다 보냄
  for (let i = 0; i < chunks.length - 1; i++) {
    await postStatus(client, channel, threadTs, chunks[i]);
  }

  // 마지막 청크 + 버튼
  return client.chat.postMessage({
    channel, thread_ts: threadTs, mrkdwn: true, text: "Completed!",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `✅ *Completed!*\n\n${chunks[chunks.length - 1]}` },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🚀 New Task", emoji: true },
            style: "primary",
            action_id: "new_task",
            value: JSON.stringify({ channel, threadTs }),
            //  value 는 문자열만 가능하므로 객체를 JSON 문자열로 바꿔 저장.
            //  나중에 버튼 누르면 JSON.parse 로 다시 객체로 복원.
          },
          {
            type: "button",
            text: { type: "plain_text", text: "🛑 Exit Session", emoji: true },
            style: "danger",
            action_id: "exit_session",
            value: JSON.stringify({ channel, threadTs }),
          },
        ],
      },
    ],
  });
}


// ─── 16단계: 파일 읽기 도구들 ──────────────────────────────────────────────────

// Claude 에게 넘길 "코드 파일 확장자" 목록.
// Set 은 중복 없는 목록. .has() 로 포함 여부를 빠르게 체크 가능.
const CODE_EXTS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".cpp", ".c", ".h",
  ".go", ".rs", ".rb", ".sh", ".yaml", ".yml", ".json", ".toml",
  ".md", ".txt", ".html", ".css", ".sql",
]);

// 파일을 안전하게 읽기 (에러 나면 null 반환, 너무 크면 "크다"라고 표시).
function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);                            // 파일 정보(크기 등) 얻기
    if (stat.size > 100 * 1024) {                                  // 100KB 넘으면
      return `[File is too large (exceeds 100KB): ${filePath}]`;
    }
    return fs.readFileSync(filePath, "utf-8");                     // 실제 내용 읽기
  } catch {
    return null;  // 존재하지 않거나 권한 없으면 null
  }
}

// 디렉토리 안의 코드 파일들을 최대 maxFiles 개까지 모아서 배열로 반환.
// 내부에 walk() 함수가 정의되어 있고 재귀 호출로 하위 폴더까지 뒤집니다.
function collectFiles(dirPath, maxFiles = 30) {
  const results = [];

  function walk(current) {
    if (results.length >= maxFiles) return;  // 충분히 모았으면 중단
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });  // 폴더 내용 목록
    } catch {
      return;  // 접근 실패 시 조용히 넘김
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;

      // 숨김 폴더(.git 등) 또는 빌드 아티팩트 폴더는 건너뜀
      if (entry.name.startsWith(".") ||
          ["node_modules","__pycache__",".git","dist","build"].includes(entry.name)) {
        continue;
      }

      const fullPath = path.join(current, entry.name);  // 경로 합치기
      if (entry.isDirectory()) {
        walk(fullPath);  // 하위 폴더면 재귀 호출
      } else if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        // 코드 파일 확장자면 읽어서 결과에 추가
        const content = readFileSafe(fullPath);
        if (content !== null) results.push({ path: fullPath, content });
      }
    }
  }

  walk(dirPath);
  return results;
}

// 유저가 입력한 텍스트에서 "슬래시로 시작하는 경로" 를 모두 뽑아내고,
// 실제로 존재하는 것만 남겨서 반환.
function extractPaths(text) {
  const matches = text.match(/\/[^\s`'"，,]+/g) || [];  // 경로 후보 추출
  // .filter(콜백) 은 "콜백이 true 돌려주는 원소만 남김".
  return matches.filter(p => {
    try {
      fs.accessSync(p);  // 접근 가능하면 아무 일도 안 일어남 → 유효
      return true;
    } catch {
      return false;      // 존재 안 하면 제외
    }
  });
}

// 경로 배열을 받아서 Claude 에게 넣어줄 "파일 내용 덩어리" 문자열로 만듦.
// 결과는 Markdown 형식(```언어 … ```).
function buildFileContext(paths) {
  if (paths.length === 0) return "";

  let ctx = "\n\n---\nContent of required file/directory contents:\n\n";

  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      ctx += `[Absent path: ${p}]\n`;
      continue;
    }
    if (stat.isDirectory()) {
      const files = collectFiles(p);
      if (files.length === 0) {
        ctx += `[Empty directory: ${p}]\n`;
        continue;
      }
      ctx += `### 📁 ${p} (${files.length} files)\n\n`;
      for (const f of files) {
        const ext = path.extname(f.path).slice(1) || "txt";  // ".py" → "py"
        ctx += `**${f.path}**\n\`\`\`${ext}\n${f.content}\n\`\`\`\n\n`;
      }
    } else {
      const content = readFileSafe(p);
      if (content === null) { ctx += `[Failed reading file: ${p}]\n`; continue; }
      const ext = path.extname(p).slice(1) || "txt";
      ctx += `**${p}**\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
    }
  }
  return ctx;
}


// ─── 17단계: Claude 답변에서 <<<WRITE:경로>>> 블록 찾아 실제로 파일 쓰기 ──────
//
// Claude 가 이런 식으로 답하면:
//   <<<WRITE:/tmp/hello.txt>>>
//   안녕
//   <<<END>>>
// 이 함수가 /tmp/hello.txt 에 "안녕"을 실제로 저장합니다.
function parseAndApplyWrites(responseText) {
  // 정규식: <<<WRITE:경로>>>부터 <<<END>>>까지 매치
  //   [^>]+   : > 가 아닌 문자 1개 이상 → 경로
  //   [\s\S]*?: 줄바꿈 포함 모든 문자(짧게) → 내용
  const writeRegex = /<<<WRITE:([^>]+)>>>\n([\s\S]*?)<<<END>>>/g;

  const written = [];  // 실제로 저장한 파일 경로 목록
  let match;
  // exec 를 반복 호출하며 모든 매치를 순회
  while ((match = writeRegex.exec(responseText)) !== null) {
    const filePath = match[1].trim();  // 첫 번째 캡처 = 경로
    const content  = match[2];         // 두 번째 캡처 = 내용
    try {
      // 디렉토리가 없을 수도 있으니 recursive 로 부모 폴더까지 생성
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      written.push(filePath);
    } catch (e) {
      written.push(`[Failed writing: ${filePath} — ${e.message}]`);
    }
  }

  // 답변에서 WRITE 블록들을 제거한 버전(유저에게 보여줄 요약용)
  const cleaned = responseText.replace(/<<<WRITE:[^>]+>>>\n[\s\S]*?<<<END>>>/g, "").trim();
  return { cleaned, written };
}


// ─── 18단계: Claude 답변에서 <<<SHELL:디렉토리>>> 블록 찾아 실제로 셸 실행 ────
//
// Claude 가 이런 식으로 답하면:
//   <<<SHELL:/home/user>>>
//   git add . && git commit -m "fix"
//   <<<END>>>
// 이 함수가 해당 디렉토리에서 해당 명령을 실행합니다.
function parseAndRunShell(responseText) {
  const shellRegex = /<<<SHELL(?::([^>]+))?>>>\n([\s\S]*?)<<<END>>>/g;
  const results = [];

  let match;
  while ((match = shellRegex.exec(responseText)) !== null) {
    // :디렉토리 가 생략됐으면 현재 프로세스의 작업 디렉토리 사용
    const cwd = match[1] ? match[1].trim() : process.cwd();
    const commands = match[2].trim();

    // 임시 셸 스크립트 파일을 만들어서 bash 로 돌리는 방식.
    // 여러 줄 명령도 안전하게 처리하려고 이렇게 함.
    const tmpFile = `/tmp/claude_shell_${Date.now()}.sh`;
    try {
      fs.writeFileSync(tmpFile, commands, "utf-8");
      const output = execSync(`bash ${tmpFile}`, {
        cwd,                    // 작업 디렉토리 지정
        encoding: "utf-8",      // 결과를 문자열로 받기
        timeout: 30000,         // 30초 지나면 강제 종료 (무한루프 방지)
      });
      results.push({
        commands,
        output: output.trim() || "(no output)",
        success: true,
      });
    } catch (e) {
      // 실패해도 에러 정보를 기록
      results.push({
        commands,
        output: (e.stderr || e.message).trim(),
        success: false,
      });
    } finally {
      // 성공/실패 상관없이 임시 파일은 지워줌
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  const cleaned = responseText.replace(/<<<SHELL(?::[^>]+)?>>>\n[\s\S]*?<<<END>>>/g, "").trim();
  return { cleaned, results };
}


// ─── 19단계: Claude 에게 주는 시스템 프롬프트 ────────────────────────────────
// "시스템 프롬프트" = 모든 대화 앞에 자동으로 붙는 지시사항.
// 여기서 Claude 에게 "파일 만들 땐 WRITE 블록 써라, 명령 실행은 SHELL 블록 써라"
// 라고 미리 교육시킵니다.
const SYSTEM_PROMPT = `You are an AI coding assistant with direct file system and shell access.

CRITICAL: You MUST use these exact block formats. Never say "I cannot run commands" — you CAN.

To write/create files:
<<<WRITE:/absolute/path/to/file>>>
file content here
<<<END>>>

To run shell commands:
<<<SHELL:/working/directory>>>
command here
<<<END>>>

MANDATORY RULES:
- ALWAYS use WRITE block to create/modify files — NEVER show file content inside markdown code blocks
- ALWAYS use SHELL block for any git operation — never just show commands as text
- When asked to update a file: WRITE the full updated content, then SHELL to git add + commit + push
- Multiple WRITE and SHELL blocks are allowed in one response
- Write a short summary outside the blocks explaining what you did
- DO NOT show file contents in markdown code blocks — use WRITE blocks only`;


// ─── 20단계: tmux 헬퍼 — 세션 타겟 문자열 정리 / 키 전송 / 화면 캡처 ─────────

// sessionId 가 "0" 이면 "0:0.0" 로 바꾸고, 이미 "0:1.2" 처럼 콜론 있으면 그대로.
// 이유: tmux send-keys 는 "세션:윈도우.pane" 형식을 기대하기 때문.
function getTmuxTarget(sessionId) {
  if (sessionId.includes(":")) return sessionId;
  return `${sessionId}:0.0`;
}

// tmux 세션에 텍스트를 "키 입력한 것처럼" 보내고 Enter 치기.
// JSON.stringify(text) 는 특수문자(따옴표, 공백 등)를 안전하게 감싸는 용도.
function tmuxSend(text) {
  execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} ${JSON.stringify(text)} Enter`);
}

// tmux 화면 내용을 통째로 읽어오기.
//   -p : stdout 으로 출력
//   -S -1000 : 스크롤백 1000줄까지 포함
function tmuxCapture() {
  const raw = execSync(
    `tmux capture-pane -t ${getTmuxTarget(currentTmuxSession)} -p -S -1000`,
    { encoding: "utf-8" }
  );
  // ANSI 이스케이프 제거해서 깨끗한 문자열로 돌려줌
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}


// ─── 21단계: /claude 명령의 핵심 — Claude 를 호출해서 작업시키기 ──────────────
//
// client:     Slack API 클라이언트
// channel:    Slack 채널 ID
// threadTs:   스레드의 뿌리 메시지 타임스탬프
// userPrompt: 유저가 입력한 작업 설명
// existingMessages: 이전 대화 기록 (스레드 이어가기에 사용)
async function runTask(client, channel, threadTs, userPrompt, existingMessages = []) {
  const key = sessionKey(channel, threadTs);
  // 이 스레드에 새 세션 정보를 등록. aborted 플래그는 "도중에 취소됐나?".
  sessions.set(key, { messages: existingMessages, aborted: false });

  // 유저 입력에서 경로 후보 뽑고, 실제 존재하면 "파일 읽는 중" 메시지 출력
  const detectedPaths = extractPaths(userPrompt);
  if (detectedPaths.length > 0) {
    await postStatus(client, channel, threadTs, `📂 Path: \`${detectedPaths.join(", ")}\` — Reading files…`);
  }
  await postStatus(client, channel, threadTs, `⚙️ *Working…*\n> ${userPrompt}`);

  // 파일 내용을 Claude 에게 넘길 수 있게 문자열로 준비
  const fileContext = buildFileContext(detectedPaths);

  // Claude 에게 보낼 메시지 목록 만들기.
  // [...existingMessages, 새메시지] 는 "기존 배열 펼치고 뒤에 하나 추가" 라는 뜻.
  const messages = [
    ...existingMessages,
    { role: "user", content: userPrompt + fileContext },
  ];

  try {
    const session = sessions.get(key);
    if (session.aborted) return;  // 유저가 취소했으면 중단

    // Claude API 에 스트리밍 방식으로 요청 보내기.
    // (스트리밍 = 답변을 토막토막 실시간으로 받는 방식)
    const stream = await anthropic.messages.stream({
      model: MODEL,            // 쓸 모델
      max_tokens: 24000,       // 최대 몇 토큰까지 생성할지
      system: SYSTEM_PROMPT,   // 시스템 지시사항
      messages,                // 대화 내역
    });

    // 스트림이 끝나길 기다린 뒤 최종 메시지 객체 받기
    const response = await stream.finalMessage();

    // 응답 내용 중 텍스트 블록들만 골라 하나로 이어붙임.
    // 비어있으면 "_(no output)_" 로 대체.
    const rawText = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim() || "_(no output)_";

    // 답변 안의 <<<WRITE>>> 블록을 처리해서 실제 파일 저장
    const { cleaned: afterWrite, written } = parseAndApplyWrites(rawText);
    // 남은 텍스트에서 <<<SHELL>>> 블록을 처리해서 실제 명령 실행
    const { cleaned: finalText, results: shellResults } = parseAndRunShell(afterWrite);

    // 요약 문자열을 조립: Claude 설명 + 저장한 파일 목록 + 셸 출력
    let summary = finalText;
    if (written.length > 0) {
      summary += `\n\n📝 *Saved files:*\n${written.map(f => `• \`${f}\``).join("\n")}`;
    }
    for (const r of shellResults) {
      const icon = r.success ? "✅" : "❌";
      summary += `\n\n${icon} *Shell output:*\n\`\`\`\n$ ${r.commands}\n${r.output}\n\`\`\``;
    }

    // 이번 대화를 세션에 기록 (다음 turn 에서 맥락으로 쓸 수 있게)
    if (sessions.has(key)) {
      sessions.get(key).messages = [
        ...existingMessages,
        { role: "user",      content: userPrompt },
        { role: "assistant", content: rawText    },
      ];
    }

    // 결과를 Slack 에 "New Task / Exit Session" 버튼과 함께 올림
    await postWithActions(client, channel, threadTs, summary || "_Completed_");

  } catch (err) {
    // API 호출 중 문제가 생기면 에러 메시지를 Slack 에 올리고 세션 제거
    console.error("API error:", err);
    await postStatus(client, channel, threadTs, `❌ *Error:* ${err.message}`);
    sessions.delete(key);
  }
}


// ─── 22단계: /claude 슬래시 명령어 핸들러 ────────────────────────────────────
app.command("/claude", async ({ command, ack, client }) => {
  await ack();
  const task = command.text.trim();
  if (!task) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Usage: `/claude <task>`\nExamples:\n• `/claude /path/to/repo review the code`\n• `/claude /path/to/repo fix bug in main.py and push`",
    });
    return;
  }
  // 시작 메시지(이 메시지의 타임스탬프가 이후 스레드의 뿌리가 됨)
  const initMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🤖 *Claude session* — <@${command.user_id}> started this session`,
  });
  await runTask(client, command.channel_id, initMsg.ts, task);
});


// ─── 23단계: 스레드 댓글 이벤트 핸들러 ────────────────────────────────────────
//  - 스레드 안에 유저가 댓글을 달면 이 함수가 실행됩니다.
//  - tmux 스트림 스레드 안인지, 일반 Claude 세션 스레드 안인지 분기 처리.
app.message(async ({ message, client }) => {
  // 봇 자신의 메시지거나 스레드 댓글이 아닌 메시지는 무시
  if (message.subtype === "bot_message" || !message.thread_ts) return;

  const text = message.text && message.text.trim();
  if (!text) return;

  // ── (A) tmux 스트림 스레드 안에 단 댓글인 경우 ──
  if (currentTmuxSession &&
      message.thread_ts === tmuxStreamTs &&
      message.channel   === tmuxStreamChannel) {

    // (A-1) "tmux-status" 라고 치면 현재 tmux 화면을 스레드에 올려줌
    if (text.toLowerCase() === "tmux-status") {
      try {
        const raw = tmuxCapture();
        const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
        const output = stripped.trim().slice(-2800);
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `📺 *Current output:*\n\`\`\`\n${output}\n\`\`\``,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `❌ Error: ${err.message}`,
        });
      }
      return;
    }

    // (A-2) "status" 라고 치면 tmux 안의 claude-code 에 "/status" 를 보내서
    //       남은 사용량 같은 정보를 받아와 표시.
    if (text.toLowerCase() === "status") {
      try {
        execSync(`tmux send-keys -t ${currentTmuxSession} '/status' Enter`, { encoding: "utf-8" });
        await new Promise(r => setTimeout(r, 2000));  // claude-code 가 응답 띄울 시간 2초
        const raw = tmuxCapture();
        const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `📊 *Status:*\n\`\`\`\n${stripped.trim().slice(-2800)}\n\`\`\``,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `❌ Error: ${err.message}`,
        });
      }
      return;
    }

    // (A-3) "? <질문>" 꼴이면 Claude API 에 짧은 일반 질문 보내기.
    //       ※ 현재 터미널 화면은 포함하지 않음. 터미널 맥락과 무관한 일반 질문용.
    if (text.startsWith("?")) {
      const prompt = text.slice(1).trim();  // "?" 빼고 질문만

      await postStatus(client, message.channel, message.thread_ts, `⚙️ *Working…*\n> ${prompt}`);

      try {
        const stream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: 3000,  // 짧은 답만 받을 거라 3000 토큰
          system: "You are a helpful assistant. Be concise. Answer in 3-5 sentences max unless code is required.",
          messages: [{ role: "user", content: prompt }],
        });
        const response = await stream.finalMessage();
        const answer = response.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n")
          .trim();

        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.thread_ts,
          text: answer.slice(0, 2800),  // Slack 1개 메시지 한도 고려해 2800자 컷
          mrkdwn: true,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.thread_ts,
          text: `❌ Error: ${err.message}`,
        });
      }
      return;
    }

    // (A-4) 그 외 일반 텍스트 → 그대로 tmux 에 키 입력
    awaitingPermission = false;
    tmuxSend(text);
    return;
  }

  // ── (B) /claude 로 시작된 일반 Claude 세션 스레드에 단 댓글인 경우 ──
  const key = sessionKey(message.channel, message.thread_ts);
  const session = sessions.get(key);
  if (!session || !message.text) return;
  // 기존 대화 맥락(session.messages) 을 넘겨서 이어 작업
  await runTask(client, message.channel, message.thread_ts, text, session.messages);
});


// ─── 24단계: "New Task" / "Exit Session" 버튼 핸들러 ─────────────────────────

// 유저가 "🚀 New Task" 누르면 "다음 작업을 입력하세요" 안내
app.action("new_task", async ({ body, ack, client }) => {
  await ack();
  // body.actions[0].value 에 들어있는 JSON 문자열을 다시 객체로 복원
  const { channel, threadTs } = JSON.parse(body.actions[0].value);
  await postStatus(client, channel, threadTs, "💬 Please input next task!");
});

// 유저가 "🛑 Exit Session" 누르면 해당 세션 삭제하고 종료 메시지 출력
app.action("exit_session", async ({ body, ack, client }) => {
  await ack();
  const { channel, threadTs } = JSON.parse(body.actions[0].value);
  const key = sessionKey(channel, threadTs);
  const session = sessions.get(key);
  if (session) {
    session.aborted = true;         // 진행 중이면 중단 플래그 세움
    sessions.delete(key);           // 세션 기록 삭제
  }
  await postStatus(client, channel, threadTs, "👋 *Session ended.* Use `/claude <task>` to start a new one.");
});


// ─── 25단계: 서버 실행 (파일 맨 마지막) ───────────────────────────────────────
//
// 즉시 실행 함수식(IIFE): (async () => { ... })();
//   - async 화살표 함수를 정의하고 바로 호출.
//   - 왜? 최상위에서 await 쓰기 위해. (구버전 Node.js 문법)
(async () => {
  await app.start();  // Slack 봇 연결 시작 (Socket Mode 로)
  console.log("⚡ Claude ↔ Slack running! (read + write + shell + tmux enabled)");

  // 예상치 못한 에러로 프로세스가 죽으려 할 때 호출되는 전역 핸들러.
  // Slack 연결이 끊어질 때 나는 "Unhandled event" 에러만 잡아서
  // 5초 뒤에 종료(exit code 1) → 자동 재시작 루프가 다시 살려주길 기대.
  process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err.message);
    if (err.message.includes("Unhandled event")) {
      console.log("Restarting in 5 seconds...");
      setTimeout(() => process.exit(1), 5000);
    }
  });
})();
