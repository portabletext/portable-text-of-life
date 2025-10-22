import {
  ChildPath,
  Editor,
  EditorSelector,
  PortableTextChild,
  useEditor,
} from '@portabletext/editor'
import {
  BehaviorAction,
  defineBehavior,
  effect,
  raise,
} from '@portabletext/editor/behaviors'
import {BehaviorPlugin} from '@portabletext/editor/plugins'
import {
  getFocusInlineObject,
  getPreviousInlineObject,
  getSelectedValue,
} from '@portabletext/editor/selectors'
import {isTextBlock} from '@portabletext/editor/utils'
import {defineInputRule, InputRulePlugin} from '@portabletext/plugin-input-rule'
import {useActorRef} from '@xstate/react'
import {useMemo} from 'react'
import {fromCallback, setup} from 'xstate'

export type CellInlineObject = {
  _type: 'cell'
  _key: string
  alive: boolean
}

export function isCellInlineObject(
  child: PortableTextChild,
): child is CellInlineObject {
  return child._type === 'cell'
}

/**
 * Sets up a heartbeat as well as a few Behaviors to turn the editor into a
 * game of life.
 */
export function PortableTextOfLifePlugin() {
  const editor = useEditor()
  const heartbeat = useActorRef(heartbeatMachine, {input: {editor}})
  const inputRules = useMemo(
    () => [
      // Type "stop!" to stop the game
      defineInputRule({
        on: /stop!/,
        actions: [
          ({event}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            effect(() => {
              heartbeat.send({type: 'stop'})
            }),
          ],
        ],
      }),

      // Type "start!" to start the game
      defineInputRule({
        on: /start!/,
        actions: [
          ({event}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            effect(() => {
              heartbeat.send({type: 'start'})
            }),
          ],
        ],
      }),

      // Type "random!" to set the cells to a random state
      defineInputRule({
        on: /random!/,
        guard: ({snapshot}) => {
          return {cells: getCells(snapshot)}
        },
        actions: [
          ({event}, {cells}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            ...cells.map((cell) =>
              raise({
                type: 'child.set',
                at: cell.path,
                props: {alive: Math.random() < 0.5},
              }),
            ),
          ],
        ],
      }),

      // Type "reset!" to set the cells to a dead state
      defineInputRule({
        on: /reset!/,
        guard: ({snapshot}) => {
          return {cells: getCells(snapshot)}
        },
        actions: [
          ({event}, {cells}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            ...cells.map((cell) =>
              raise({
                type: 'child.set',
                at: cell.path,
                props: {alive: false},
              }),
            ),
          ],
        ],
      }),

      // Type "spawn1!" or "spawn0!" to create new cells
      defineInputRule({
        on: /spawn1!|spawn0!/,
        actions: [
          ({event}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            ...event.matches.map((match) =>
              raise({
                type: 'insert.child',
                child: {
                  _type: 'cell',
                  alive: match.text === 'spawn1!',
                },
              }),
            ),
          ],
        ],
      }),
    ],
    [heartbeat, editor],
  )
  const behaviors = useMemo(
    () => [
      /**
       * Click to flip the state of the focused cell.
       */
      defineBehavior({
        on: 'mouse.click',
        guard: ({snapshot, event}) => {
          const focusInlineObject =
            getFocusInlineObject({
              ...snapshot,
              context: {
                ...snapshot.context,
                selection: event.position.selection,
              },
            }) ??
            // We probably hit an empty span. Let's find the previous
            // inline object.
            getPreviousInlineObject({
              ...snapshot,
              context: {
                ...snapshot.context,
                selection: event.position.selection,
              },
            })

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
       * Press SPACE to flip the state of all selected cells.
       */
      defineBehavior({
        on: 'keyboard.keydown',
        guard: ({snapshot, event}) => {
          if (event.originEvent.key !== ' ') {
            return false
          }

          const selectedValue = getSelectedValue(snapshot)
          const cellsSelected = getCells({
            ...snapshot,
            context: {
              ...snapshot.context,
              value: selectedValue,
            },
          })

          return {cellsSelected}
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
          const grid = getCellGrid(snapshot)

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
              const neighborsAlive = countLiveNeighbors(
                grid,
                rowIndex,
                cellIndex,
              )

              let newAlive = cell.node.alive

              if (cell.node.alive) {
                // Live cell with 2-3 neighbors survives
                newAlive = neighborsAlive === 2 || neighborsAlive === 3
              } else {
                // Dead cell with exactly 3 neighbors becomes alive
                newAlive = neighborsAlive === 3
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
    ],
    [],
  )

  return (
    <>
      <div>
        <p>
          Type <em>stop!</em>, <em>start!</em>, <em>reset!</em> or{' '}
          <em>random!</em> to control the game.
        </p>
        <p>
          Type <em>spawn1!</em> or <em>spawn0!</em> to create new cells.
        </p>
        <p>
          Click on cells or press <kbd>SPACE</kbd> to flip the state of all
          selected cells.
        </p>
      </div>
      <InputRulePlugin rules={inputRules} />
      <BehaviorPlugin behaviors={behaviors} />
    </>
  )
}

/**
 * Custom Selector to get all cells in the editor.
 */
const getCells: EditorSelector<
  Array<{
    node: CellInlineObject
    path: ChildPath
  }>
> = (snapshot) => {
  return snapshot.context.value.flatMap((block) => {
    if (!isTextBlock(snapshot.context, block)) {
      return []
    }

    return block.children.flatMap((child) => {
      if (!isCellInlineObject(child)) {
        return []
      }

      return {
        node: child,
        path: [
          {_key: block._key},
          'children',
          {_key: child._key},
        ] satisfies ChildPath,
      }
    })
  })
}

/**
 * Custom Selector to get all cells as a 2D grid.
 */
const getCellGrid: EditorSelector<
  Array<
    Array<{
      node: CellInlineObject
      path: ChildPath
    }>
  >
> = (snapshot) => {
  const grid: Array<
    Array<{
      node: CellInlineObject
      path: ChildPath
    }>
  > = []

  for (const block of snapshot.context.value) {
    if (!isTextBlock(snapshot.context, block)) {
      continue
    }

    const cells: Array<{
      node: CellInlineObject
      path: ChildPath
    }> = []

    for (const child of block.children) {
      if (!isCellInlineObject(child)) {
        continue
      }

      cells.push({
        node: child,
        path: [
          {_key: block._key},
          'children',
          {_key: child._key},
        ] satisfies ChildPath,
      })
    }

    grid.push(cells)
  }

  return grid
}

function countLiveNeighbors(
  grid: Array<Array<{path: ChildPath; node: CellInlineObject}>>,
  rowIndex: number,
  colIndex: number,
): number {
  const rowNorth = rowIndex > 0 ? grid.at(rowIndex - 1) : undefined
  const row = grid.at(rowIndex)
  const rowSouth =
    rowIndex < grid.length - 1 ? grid.at(rowIndex + 1) : undefined

  const cellNorthWest = rowNorth?.at(colIndex - 1)?.node.alive ? 1 : 0
  const cellNorth = rowNorth?.at(colIndex)?.node.alive ? 1 : 0
  const cellNorthEast = rowNorth?.at(colIndex + 1)?.node.alive ? 1 : 0
  const cellWest = row?.at(colIndex - 1)?.node.alive ? 1 : 0
  const cellEast = row?.at(colIndex + 1)?.node.alive ? 1 : 0
  const cellSouthWest = rowSouth?.at(colIndex - 1)?.node.alive ? 1 : 0
  const cellSouth = rowSouth?.at(colIndex)?.node.alive ? 1 : 0
  const cellSouthEast = rowSouth?.at(colIndex + 1)?.node.alive ? 1 : 0

  return (
    cellNorthWest +
    cellNorth +
    cellNorthEast +
    cellWest +
    cellEast +
    cellSouthWest +
    cellSouth +
    cellSouthEast
  )
}

const heartbeatMachine = setup({
  types: {
    context: {} as {
      editor: Editor
    },
    input: {} as {
      editor: Editor
    },
    events: {} as {type: 'tick'} | {type: 'stop'} | {type: 'start'},
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
        start: {
          target: 'running',
        },
      },
    },
    running: {
      invoke: {
        src: 'tick',
      },
      on: {
        tick: {
          actions: [
            ({context}) => {
              context.editor.send({type: 'custom.tick'})
            },
          ],
        },
        stop: {
          target: 'paused',
        },
      },
    },
  },
})
