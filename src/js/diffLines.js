export function diffLines(text) {
 return String(text).split('\n').map(line=>({line,kind:/^(\+\+\+|---)\s/.test(line)||/^diff |^index /.test(line)?'file':line.startsWith('@@')?'hunk':line.startsWith('+')?'add':line.startsWith('-')?'del':''}));
}
