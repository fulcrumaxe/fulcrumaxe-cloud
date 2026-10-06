interface Props {
  start: number;
  format: (n: number) => string;
}

export function FixtureView({ start, format }: Props) {
  let n = start;
  const readout = <p data-testid="fp-fixture-count">{format(n)}</p>;
  return (
    <section class="fp-fixture" data-testid="fp-fixture-root">
      <h2>First-party fixture app</h2>
      {readout}
      <button
        type="button"
        onClick={() => {
          n += 1;
          readout.textContent = format(n);
        }}
      >
        Count
      </button>
    </section>
  );
}
