// A menu Claude Code shows in the terminal and waits on, read from the screen: a
// tool's own question (computer use asking for macOS permissions), a permission
// prompt, a question with choices. The chat did not know one was there and showed
// the agent as still working.
const crypto=require('node:crypto');

// The hint line under every such menu.
const HINT=/(Enter to (confirm|select|continue)|Esc to (cancel|exit|go back|close))/i;
const RULE=/^\s*[─━═╌┄-]{8,}\s*$/;
const POINTER='❯';

// {key, title, body, options:[{label}], selected} or null. Only the part of the
// screen above the hint and below the last rule line is read.
function parse(screen){
 const lines=String(screen||'').replace(/\r/g,'').split('\n');
 let hint=-1,fallbackHint=null;
 for(let i=lines.length-1;i>=0&&i>=lines.length-12;i--)if(HINT.test(lines[i])){hint=i;break;}
 // A numbered menu with another hint under it, as the plan's "Would you like to
 // proceed?" has ("ctrl+g to edit in VS Code"): read to the end of the screen (an agent waiting on one the chat never showed).
 if(hint<0){
  let end=lines.length;while(end>0&&!lines[end-1].trim())end--;
  const numbered=lines.slice(Math.max(0,end-20),end).some(l=>/^\s*❯ \d+\. \S/.test(l));
  if(!numbered)return null;
  hint=end;fallbackHint=lines[end-1].trim();
 }
 let top=hint-1;
 while(top>=0&&!RULE.test(lines[top]))top--;
 // A question's last choice ("Chat about this") sits under a rule of its own:
 // with no pointer below that rule, the menu starts above the next one (an agent's question never reached the chat).
 if(top>0&&!lines.slice(top+1,hint).some(l=>l.trimStart().startsWith(POINTER+' '))){
  let above=top-1;while(above>=0&&!RULE.test(lines[above]))above--;
  if(lines.slice(above+1,top).some(l=>l.trimStart().startsWith(POINTER+' ')))top=above;
 }
 const block=lines.slice(top+1,hint).filter(l=>!RULE.test(l));
 const at=block.findIndex(l=>l.trimStart().startsWith(POINTER+' '));
 if(at<0)return null;
 const column=block[at].indexOf(POINTER)+2;
 const isOption=l=>l.length>column&&/^\s*$/.test(l.slice(0,column))&&l[column]!==' ';
 let first=at,last=at;
 // Neighbouring options start in the pointer's text column; a description under an
 // option is indented further and belongs to it.
 const belongs=l=>isOption(l)||(l.slice(0,column+1).trim()===''&&l.trim()!=='');
 while(first>0&&belongs(block[first-1])&&!block[first-1].includes(POINTER))first--;
 while(first<at&&!isOption(block[first]))first++;
 while(last+1<block.length&&belongs(block[last+1]))last++;
 const options=[];let selected=0;
 for(let i=first;i<=last;i++){
  const l=block[i];
  if(i===at){selected=options.length;options.push({label:l.slice(column).trim()});}
  else if(isOption(l))options.push({label:l.slice(column).trim()});
  else if(options.length)options.at(-1).detail=((options.at(-1).detail||'')+' '+l.trim()).trim();
 }
 if(!options.length||options.length>20)return null;
 const text=block.slice(0,first).map(l=>l.trimEnd()).join('\n').replace(/^\n+|\n+$/g,'').replace(/\n{3,}/g,'\n\n');
 const [title='',...rest]=text.split('\n');
 const indent=Math.min(...rest.filter(l=>l.trim()).map(l=>l.match(/^ */)[0].length),99);
 const body=rest.map(l=>l.slice(Math.min(indent,l.match(/^ */)[0].length))).join('\n').trim();
 const hintText=fallbackHint??lines[hint].trim();
 // A countdown on the menu ("will automatically deny this request in 1:39") changes every
 // second; the menu is the same one, so its clock is left out of what names it, also when
 // the phrase wraps on a narrow screen; anything else, the command itself, still counts. Counted
 // in, a choice made from the chat was refused as for another menu.
 const key=crypto.createHash('sha256').update(text.replace(/(\bwill\s+automatically\s+\w+\s+this\s+request\s+in\s+)(\d{1,3}:\d{2}|\d{1,3}s)\b/gi,'$1#')+'\n'+options.map(o=>o.label).join('\n')).digest('hex').slice(0,24);
 return {key,title:title.trim().slice(0,200),body:body.slice(0,2000),options:options.map(o=>({label:o.label.slice(0,200),...(o.detail?{detail:o.detail.slice(0,300)}:{})})),selected,hint:hintText.slice(0,120)};
}

// The keys that move from the selected option to the chosen one and confirm it.
function keysFor(prompt,index){
 const d=index-prompt.selected;
 return [...Array(Math.abs(d)).fill(d>0?'Down':'Up'),'Enter'];
}
module.exports={parse,keysFor};
