import { SIZE, play } from './gomoku.mjs'

const DIRECTIONS = [[1,0],[0,1],[1,1],[1,-1]]
const WIN = 100000000
const CONFIG = {
  easy: { depth:1, width:5, milliseconds:100, nodes:500, choices:4 },
  normal: { depth:2, width:8, milliseconds:350, nodes:3000, choices:1 },
  hard: { depth:3, width:10, milliseconds:900, nodes:10000, choices:1 },
}
const index = (x,y) => x < 0 || x >= SIZE || y < 0 || y >= SIZE ? -1 : y * SIZE + x
function candidatePoints(board) {
  const found = new Set(); let occupied = false
  for (let i=0;i<board.length;i++) if (board[i]) {
    occupied = true; const x=i%SIZE, y=Math.floor(i/SIZE)
    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) {
      const n=index(x+dx,y+dy); if(n>=0 && !board[n]) found.add(n)
    }
  }
  return occupied ? [...found] : [index(7,7)]
}
// A quick score for ordering moves, including broken threats.
function pointScore(board, point, color) {
  const x=point%SIZE, y=Math.floor(point/SIZE); let total=0
  for (const [dx,dy] of DIRECTIONS) {
    for (let start=-4;start<=0;start++) {
      let own=0, blocked=false
      for (let d=0;d<5;d++) {
        const n=index(x+(start+d)*dx,y+(start+d)*dy)
        if(n<0 || (n!==point && board[n] && board[n]!==color)) {blocked=true;break}
        if(n===point || board[n]===color) own++
      }
      if(!blocked) total += [0,2,15,140,3000,WIN][own]
    }
  }
  return total
}
function evaluate(board, color) {
  let score=0
  for(let y=0;y<SIZE;y++) for(let x=0;x<SIZE;x++) for(const [dx,dy] of DIRECTIONS) {
    if(index(x+4*dx,y+4*dy)<0) continue
    let a=0,b=0
    for(let d=0;d<5;d++){const v=board[index(x+d*dx,y+d*dy)];if(v===color)a++;else if(v)b++}
    if(a && b) continue
    if(a)score += [0,1,12,120,3500,WIN][a]
    if(b)score -= [0,1,12,120,3500,WIN][b]
  }
  return score
}
function rankMoves(state, width = Infinity) {
  const color=state.turn, opponent=3-color, points=candidatePoints(state.board)
  const ranked=[]
  for(const point of points) {
    const result=play(state,point)
    if(!result.state) continue
    const next=result.state
    const opp=play({...state,turn:opponent},point).state
    const immediateWin=next.phase==='finished' && next.winner===color
    const losingFoul=next.phase==='finished' && next.winner===opponent
    const blocksWin=opp?.phase==='finished' && opp.winner===opponent
    const x=point%SIZE, y=Math.floor(point/SIZE)
    const value=(immediateWin?WIN:0) + (blocksWin?WIN/2:0) - (losingFoul?WIN*2:0)
      + pointScore(state.board,point,color) + pointScore(state.board,point,opponent)*0.95
      - (Math.abs(x-7)+Math.abs(y-7))*0.15
    ranked.push({point,next,value,immediateWin,losingFoul,blocksWin})
  }
  ranked.sort((a,b)=>Number(b.immediateWin)-Number(a.immediateWin) || Number(a.losingFoul)-Number(b.losingFoul) || Number(b.blocksWin)-Number(a.blocksWin) || b.value-a.value || a.point-b.point)
  // Do not choose a losing foul if any safe move remains anywhere on the board.
  if(ranked.length && ranked.every(x=>x.losingFoul)) {
    for(let point=0;point<state.board.length;point++) if(!state.board[point] && !points.includes(point)) {
      const next=play(state,point).state
      if(next && !(next.phase==='finished' && next.winner===opponent)) ranked.push({point,next,value:-100000,immediateWin:false,losingFoul:false,blocksWin:false})
    }
    ranked.sort((a,b)=>Number(b.immediateWin)-Number(a.immediateWin) || Number(a.losingFoul)-Number(b.losingFoul) || Number(b.blocksWin)-Number(a.blocksWin) || b.value-a.value || a.point-b.point)
  }
  return ranked.slice(0,width)
}
function search(state, depth, alpha, beta, ai, context) {
  if (++context.nodes > context.maxNodes || Date.now() >= context.deadline) { context.timedOut=true; return 0 }
  if(state.phase==='finished') return state.winner===ai ? WIN+depth : state.winner ? -WIN-depth : 0
  if(depth===0) {
    // Resolve an immediate win before evaluating the position to avoid a horizon blind spot.
    for (const point of candidatePoints(state.board)) {
      if (pointScore(state.board, point, state.turn) < WIN) continue
      const next = play(state, point).state
      if (next?.phase === 'finished' && next.winner === state.turn) return state.turn === ai ? WIN : -WIN
    }
    return evaluate(state.board,ai)
  }
  const moves=rankMoves(state,context.width)
  if(!moves.length)return 0
  const max=state.turn===ai; let best=max ? -Infinity : Infinity
  for(const move of moves) {
    const value=search(move.next,depth-1,alpha,beta,ai,context)
    if(context.timedOut)return 0
    if(max){best=Math.max(best,value);alpha=Math.max(alpha,best)} else {best=Math.min(best,value);beta=Math.min(beta,best)}
    if(beta<=alpha)break
  }
  return best
}
export function chooseMove(state, difficulty='normal', options={}) {
  if(state?.phase !== 'playing') return null
  const config=CONFIG[difficulty] || CONFIG.normal
  const moves=rankMoves(state,config.width)
  if(!moves.length)return null
  if(moves[0].immediateWin)return moves[0].point
  const safe=moves.filter(m=>!m.losingFoul)
  const pool=safe.length ? safe : moves
  const blocks=pool.filter(m=>m.blocksWin)
  const initial=blocks.length ? blocks : pool
  if(config.depth===1) {
    const choices=initial.slice(0,blocks.length ? 1 : config.choices)
    return choices[Math.floor((options.random || Math.random)()*choices.length) % choices.length].point
  }
  const deadline=Date.now()+(options.milliseconds ?? config.milliseconds)
  const ctx={nodes:0,maxNodes:options.nodes ?? config.nodes,deadline,width:config.width,timedOut:false}
  let best=initial[0].point
  for(let depth=2;depth<=config.depth;depth++) {
    let bestScore=-Infinity, nextBest=best
    for(const move of initial) {
      const score=search(move.next,depth-1,-Infinity,Infinity,state.turn,ctx)
      if(ctx.timedOut)break
      if(score>bestScore){bestScore=score;nextBest=move.point}
    }
    if(ctx.timedOut)break
    best=nextBest
  }
  return best
}
