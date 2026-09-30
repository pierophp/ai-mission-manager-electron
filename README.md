# AI Mission Manager

Aplicação desktop construída com Electron, React e Vite+.

## Requisitos

- Node.js 24 ou superior
- npm 11 ou superior

## Desenvolvimento

```sh
npm install
npm run dev
```

O comando abre o servidor Vite+ e inicia o Electron com recarga rápida do renderer.

## Comandos

```sh
npm run check    # formatação, lint e checagem de tipos via Vite+
npm run build    # build de produção do renderer
npm start        # abre Electron usando o build existente
npm run package  # empacota a aplicação para o sistema atual
npm run make     # gera o artefato ZIP para o sistema atual
```

O processo principal e o preload ficam em `src/`; a interface React fica em
`src/renderer/`. A janela usa isolamento de contexto, sandbox e integração Node
desativada. Novas APIs do Electron devem ser expostas ao renderer pelo preload,
com uma superfície pequena e explícita.
