/** A local fake identity provider. The key is a public test fixture only. */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

export const idpCert = readFileSync(new URL("./saml/idp-cert.pem", import.meta.url), "utf8");
const idpKey = readFileSync(new URL("./saml/idp-key.pem", import.meta.url), "utf8");
export const idpEntityId = "https://idp.example.test";

export function requestId(authorizeUrl: string) {
  const request = new URL(authorizeUrl).searchParams.get("SAMLRequest")!;
  const xml = inflateRawSync(Buffer.from(request, "base64")).toString();
  return /\bID="([^"]+)"/.exec(xml)![1];
}

export function samlResponse(
  request: string,
  options: {
    audience?: string;
    recipient?: string;
    issuer?: string;
    expires?: string;
    signed?: boolean;
    signingKey?: string;
    signingCert?: string;
    responseSigned?: boolean;
    unsolicited?: boolean;
    doctype?: boolean;
    wrapped?: boolean;
  } = {},
) {
  const now = new Date().toISOString();
  const expires = options.expires ?? new Date(Date.now() + 300_000).toISOString();
  const callback = "https://optio.example.test/api/auth/saml/callback";
  const issuer = options.issuer ?? idpEntityId;
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response" Version="2.0" IssueInstant="${now}" Destination="${callback}" InResponseTo="${request}">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion" Version="2.0" IssueInstant="${now}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">person-123</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${request}" Recipient="${options.recipient ?? callback}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject>
    <saml:Conditions NotBefore="${new Date(Date.now() - 1000).toISOString()}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? "https://optio.example.test/api/auth/saml/metadata"}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>alice@example.test</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>Alice</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="groups"><saml:AttributeValue>Developers</saml:AttributeValue><saml:AttributeValue>CN=Admins,OU=Groups,DC=example,DC=test</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion></samlp:Response>`;
  if (options.unsolicited) xml = xml.replace(/ InResponseTo="[^"]*"/g, "");
  if (options.doctype)
    xml =
      '<!DOCTYPE samlp:Response [<!ENTITY injected "attacker@example.test">]>' +
      xml.replace("alice@example.test", "&injected;");
  if (options.signed !== false || options.responseSigned) {
    const sig = new SignedXml({
      privateKey: options.signingKey ?? idpKey,
      publicCert: options.signingCert ?? idpCert,
    });
    sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    sig.addReference({
      xpath: options.responseSigned
        ? "/*[local-name()='Response']"
        : "//*[local-name()='Assertion']",
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    sig.computeSignature(xml, {
      location: {
        reference: options.responseSigned
          ? "/*[local-name()='Response']/*[local-name()='Issuer']"
          : "//*[local-name()='Assertion']/*[local-name()='Issuer']",
        action: "after",
      },
    });
    xml = sig.getSignedXml();
  }
  if (options.wrapped) {
    const assertion = xml.match(/<saml:Assertion[\s\S]*?<\/saml:Assertion>/)![0];
    const attacker = assertion
      .replace(/<Signature[\s\S]*?<\/Signature>/, "")
      .replace('ID="_assertion"', 'ID="_attacker"')
      .replace("person-123", "attacker")
      .replace("alice@example.test", "attacker@example.test");
    xml = xml.replace(assertion, `<samlp:Extensions>${assertion}</samlp:Extensions>${attacker}`);
  }
  return Buffer.from(xml).toString("base64");
}
