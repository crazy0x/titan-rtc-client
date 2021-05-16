import connect from './index'

function sayHello(lang: string): string {
    return 'Hello, ' + lang;
}
let lang = 'typeScript';
console.log(sayHello(lang));
const client = connect('ws://localhost:3003/socket')