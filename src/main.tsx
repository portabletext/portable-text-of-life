import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  isCellInlineObject,
  PortableTextOfLifePlugin,
} from './portable-text-of-life.tsx'
import {
  BlockChildRenderProps,
  defineSchema,
  EditorProvider,
  keyGenerator,
  PortableTextEditable,
} from '@portabletext/editor'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortableTextOfLife />
  </React.StrictMode>,
)

function PortableTextOfLife() {
  return (
    <EditorProvider
      initialConfig={{
        // Initiate the editor with 16 blocks
        initialValue: Array.from({length: 16}, () => ({
          _key: keyGenerator(),
          _type: 'block',
          // Each with 16 cells with a random `alive` state
          children: Array.from({length: 16}, () => ({
            _key: keyGenerator(),
            _type: 'cell',
            alive: Math.random() < 0.5,
          })),
        })),
        schemaDefinition: defineSchema({
          inlineObjects: [
            {name: 'cell', fields: [{name: 'alive', type: 'boolean'}]},
          ],
        }),
      }}
    >
      <PortableTextEditable
        autoFocus
        className="world"
        renderChild={renderChild}
      />
      <PortableTextOfLifePlugin />
    </EditorProvider>
  )
}

function renderChild(props: BlockChildRenderProps) {
  if (isCellInlineObject(props.value)) {
    return (
      <span data-selected={props.selected}>
        {props.value.alive ? '●' : '○'}
      </span>
    )
  }

  return props.children
}
