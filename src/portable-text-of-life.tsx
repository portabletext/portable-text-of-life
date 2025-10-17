import {
  ChildPath,
  defineSchema,
  Editor,
  EditorProvider,
  keyGenerator,
  PortableTextChild,
  PortableTextEditable,
  PortableTextTextBlock,
  useEditor,
  type BlockChildRenderProps,
} from '@portabletext/editor'
import {
  BehaviorAction,
  defineBehavior,
  raise,
} from '@portabletext/editor/behaviors'
import { BehaviorPlugin } from '@portabletext/editor/plugins'
import {
  getFocusInlineObject,
  getPreviousInlineObject,
  getSelectedValue,
} from '@portabletext/editor/selectors'
import { isTextBlock } from '@portabletext/editor/utils'
import { useActorRef, useSelector } from '@xstate/react'
import { fromCallback, setup } from 'xstate'

export function PortableTextOfLife() {
  return (
    <EditorProvider
      initialConfig={{
        initialValue: createEditorValue(16, 'random'),
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
      <LifePlugin />
    </EditorProvider>
  )
}

function createEditorValue(
  size: number,
  cellState: 'alive' | 'dead' | 'random',
): Array<PortableTextTextBlock> {
  return Array.from({length: size}, () =>
    Array.from({length: size}, () =>
      cellState === 'random' ? Math.random() < 0.5 : cellState === 'alive',
    ),
  ).map((row) => deserializeBlock(row))
}

function deserializeBlock(
  serializedBlock: Array<boolean>,
): PortableTextTextBlock {
  // The editor requires at least one empty span between inline objects
  return {
    _type: 'block',
    _key: keyGenerator(),
    children: serializedBlock.flatMap((cell, index) => [
      ...(index === 0
        ? [
            {
              _key: keyGenerator(),
              _type: 'span',
              text: '',
            },
          ]
        : []),
      {
        _key: keyGenerator(),
        _type: 'cell',
        alive: cell,
      },
      {
        _key: keyGenerator(),
        _type: 'span',
        text: '',
      },
    ]),
  }
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

type CellInlineObject = {
  _type: 'cell'
  _key: string
  alive: boolean
}

function isCellInlineObject(
  child: PortableTextChild,
): child is CellInlineObject {
  return child._type === 'cell'
}

/**
 * Sets up a heartbeat as well as a few Behaviors to allow you to interact with
 * the game.
 */
function LifePlugin() {
  const editor = useEditor()
  const actorRef = useActorRef(heartbeatMachine, {input: {editor}})
  const running = useSelector(actorRef, (state) => state.matches('running'))

  return (
    <>
      <nav>
        <button
          onClick={() => {
            actorRef.send({type: 'toggle paused'})
          }}
        >
          {running ? 'stop' : 'start'}
        </button>
        <button
          onClick={() => {
            editor.send({
              type: 'update value',
              value: createEditorValue(16, 'random'),
            })
          }}
        >
          random
        </button>
        <button
          onClick={() => {
            editor.send({
              type: 'update value',
              value: createEditorValue(16, 'dead'),
            })
          }}
        >
          reset
        </button>
      </nav>
      <BehaviorPlugin
        behaviors={[
          /**
           * When clicking, flip the state of the nearest cell.
           */
          defineBehavior({
            on: 'mouse.click',
            guard: ({snapshot, event}) => {
              let focusInlineObject = getFocusInlineObject({
                ...snapshot,
                context: {
                  ...snapshot.context,
                  selection: event.position.selection,
                },
              })

              if (!focusInlineObject) {
                // We probably hit an empty span. Let's find the previous
                // inline object.
                focusInlineObject = getPreviousInlineObject({
                  ...snapshot,
                  context: {
                    ...snapshot.context,
                    selection: event.position.selection,
                  },
                })
              }

              if (
                !focusInlineObject ||
                !isCellInlineObject(focusInlineObject.node)
              ) {
                return false
              }

              return {focusInlineObject}
            },
            actions: [
              (_, {focusInlineObject}) => [
                // Flip the state of the cell
                raise({
                  type: 'child.set',
                  at: focusInlineObject.path,
                  props: {
                    alive: !focusInlineObject.node.alive,
                  },
                }),
                // And select it
                raise({
                  type: 'select',
                  at: {
                    anchor: {
                      path: focusInlineObject.path,
                      offset: 0,
                    },
                    focus: {
                      path: focusInlineObject.path,
                      offset: 0,
                    },
                  },
                }),
              ],
            ],
          }),
          /**
           * When hitting SPACE, flip the state of all selected cells.
           */
          defineBehavior({
            on: 'keyboard.keydown',
            guard: ({snapshot, event}) => {
              if (event.originEvent.key !== ' ') {
                return false
              }

              const selectedValue = getSelectedValue(snapshot)

              const cellsSelected = selectedValue.flatMap((block) =>
                isTextBlock(snapshot.context, block)
                  ? block.children.flatMap((child) =>
                      isCellInlineObject(child)
                        ? {
                            node: child,
                            path: [
                              {_key: block._key},
                              'children',
                              {_key: child._key},
                            ] satisfies ChildPath,
                          }
                        : [],
                    )
                  : [],
              )

              return {
                cellsSelected,
              }
            },
            actions: [
              (_, {cellsSelected}) =>
                cellsSelected.map((cell) =>
                  raise({
                    type: 'child.set',
                    at: cell.path,
                    props: {
                      alive: !cell.node.alive,
                    },
                  }),
                ),
            ],
          }),
          /**
           * On every tick, calculate the new state of the cells.
           */
          defineBehavior({
            on: 'custom.tick',
            guard: ({snapshot}) => {
              // Extract cells from blocks into a 2D grid
              const grid: Array<
                Array<{path: ChildPath; node: CellInlineObject}>
              > = []

              for (const block of snapshot.context.value) {
                if (!isTextBlock(snapshot.context, block)) {
                  continue
                }

                const rowCells: Array<{
                  path: ChildPath
                  node: CellInlineObject
                }> = []

                for (const child of block.children) {
                  if (isCellInlineObject(child)) {
                    rowCells.push({
                      path: [
                        {_key: block._key},
                        'children',
                        {_key: child._key},
                      ] satisfies ChildPath,
                      node: child,
                    })
                  }
                }

                if (rowCells.length > 0) {
                  grid.push(rowCells)
                }
              }

              // Figure out which cells need updating, based on the Game of Life
              // rules.
              const actions: Array<BehaviorAction> = []

              for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
                for (
                  let cellIndex = 0;
                  cellIndex < grid[rowIndex].length;
                  cellIndex++
                ) {
                  const cell = grid[rowIndex][cellIndex]
                  const neighbors = countLiveNeighbors(
                    grid,
                    rowIndex,
                    cellIndex,
                  )

                  let newAlive = cell.node.alive

                  if (cell.node.alive) {
                    // Live cell with 2-3 neighbors survives
                    newAlive = neighbors === 2 || neighbors === 3
                  } else {
                    // Dead cell with exactly 3 neighbors becomes alive
                    newAlive = neighbors === 3
                  }

                  // Only add to updates if state changed
                  if (newAlive !== cell.node.alive) {
                    actions.push(
                      raise({
                        type: 'child.set',
                        at: cell.path,
                        props: {alive: newAlive},
                      }),
                    )
                  }
                }
              }

              return actions.length > 0 ? {actions} : false
            },
            actions: [(_, {actions}) => actions],
          }),
        ]}
      />
    </>
  )
}

function countLiveNeighbors(
  grid: Array<Array<{path: ChildPath; node: CellInlineObject}>>,
  row: number,
  col: number,
): number {
  let count = 0

  // Check all 8 neighbors
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      // Skip the cell itself
      if (i === 0 && j === 0) continue

      const newRow = row + i
      const newCol = col + j

      // Check bounds
      if (
        newRow >= 0 &&
        newRow < grid.length &&
        newCol >= 0 &&
        newCol < grid[newRow].length
      ) {
        if (grid[newRow][newCol].node.alive) {
          count++
        }
      }
    }
  }

  return count
}

const heartbeatMachine = setup({
  types: {
    context: {} as {
      editor: Editor
    },
    input: {} as {
      editor: Editor
    },
    events: {} as {type: 'tick'} | {type: 'toggle paused'},
  },
  actors: {
    tick: fromCallback(({sendBack}) => {
      const interval = setInterval(() => {
        sendBack({type: 'tick'})
      }, 1000)

      return () => {
        clearInterval(interval)
      }
    }),
  },
}).createMachine({
  id: 'heartbeat',
  context: ({input}) => ({
    editor: input.editor,
  }),
  initial: 'running',
  states: {
    paused: {
      on: {
        'toggle paused': {
          target: 'running',
        },
      },
    },
    running: {
      invoke: {
        src: 'tick',
      },
      on: {
        'tick': {
          actions: [
            ({context}) => {
              context.editor.send({type: 'custom.tick'})
            },
          ],
        },
        'toggle paused': {
          target: 'paused',
        },
      },
    },
  },
})
