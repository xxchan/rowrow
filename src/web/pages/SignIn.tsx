import { Center } from "@astryxdesign/core/Center";
import { Code } from "@astryxdesign/core/Code";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";

/** Shown when this browser has no device credential (docs/decisions.md, D-009). */
export function SignIn() {
  return (
    <Center height="100%" padding={6}>
      <VStack gap={3} maxWidth={440}>
        <Heading level={1}>Sign in to rowrow</Heading>
        <Text type="body">
          This browser isn't signed in. rowrow uses one-time sign-in links instead of passwords.
        </Text>
        <Text type="body">
          On the computer running rowrow, run <Code>rowrow open</Code> (this browser) or{" "}
          <Code>rowrow pair</Code> (another device), or open <b>Settings → Pair a device</b> in a browser that
          is already signed in and scan the code.
        </Text>
      </VStack>
    </Center>
  );
}
