import { Text } from "@astryxdesign/core/Text";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  error: { color: "var(--color-error)" },
});

/** An inline error message in the theme's error color (Astryx Text has no error color). */
export function ErrorText({
  children,
  type = "supporting",
}: {
  children: ReactNode;
  type?: "supporting" | "body";
}) {
  return (
    <Text type={type} xstyle={styles.error}>
      {children}
    </Text>
  );
}
