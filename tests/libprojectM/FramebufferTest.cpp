// Framebuffer size / attachment contract.
//
// Pins down the two Framebuffer behaviours multi-target rendering relies on
// (blur render-to-texture in #177, preset-authored render targets in #229):
//
//  - SetAttachment() is insert-or-assign: re-attaching a slot replaces the
//    tracked attachment, and what GetColorAttachmentTexture() returns matches
//    the texture GL actually has bound.
//  - SetSize() reallocates attachments the framebuffer owns, but never touches
//    attachments set with AttachmentStorage::External.
//
// Every assertion is checked against GL state via
// glGetFramebufferAttachmentParameteriv, not just the tracked map.

#include "Renderer/Framebuffer.hpp"
#include "HeadlessGlContext.hpp"
#include "Renderer/OpenGL.h"
#include "Renderer/Texture.hpp"
#include "Renderer/TextureAttachment.hpp"

#include <gtest/gtest.h>

#include <memory>

namespace {

using libprojectM::Renderer::Framebuffer;
using libprojectM::Renderer::TextureAttachment;
using libprojectM::Test::HeadlessGlContext;

using AttachmentStorage = Framebuffer::AttachmentStorage;

auto MakeColorAttachment(int width, int height) -> std::shared_ptr<TextureAttachment>
{
    return std::make_shared<TextureAttachment>(GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, width, height);
}

/**
 * @brief Returns the texture name GL has bound to the given color attachment of framebuffer 0.
 */
auto BoundColorTextureName(Framebuffer& framebuffer, int attachmentIndex) -> GLuint
{
    framebuffer.Bind(0);
    GLint name{0};
    glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER,
                                          GL_COLOR_ATTACHMENT0 + attachmentIndex,
                                          GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
                                          &name);
    Framebuffer::Unbind();
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    return static_cast<GLuint>(name);
}

} // namespace

class FramebufferTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "Headless OpenGL context is unavailable on this platform.";
        }
        m_glContext = std::make_unique<HeadlessGlContext>();
        if (!m_glContext->Valid() || !m_glContext->InitializeGlad())
        {
            GTEST_SKIP() << "Failed to create headless OpenGL context for framebuffer tests.";
        }
        while (glGetError() != GL_NO_ERROR)
        {
        }
    }

    void TearDown() override
    {
        if (m_glContext)
        {
            EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
        }
    }

    std::unique_ptr<HeadlessGlContext> m_glContext;
};

TEST_F(FramebufferTest, SetAttachmentTwiceTracksLatestAttachment)
{
    Framebuffer framebuffer;
    ASSERT_TRUE(framebuffer.SetSize(32, 32));

    auto first = MakeColorAttachment(32, 32);
    auto second = MakeColorAttachment(32, 32);
    ASSERT_NE(first->Texture()->TextureID(), second->Texture()->TextureID());

    framebuffer.SetAttachment(0, 0, first);
    EXPECT_EQ(framebuffer.GetColorAttachmentTexture(0, 0), first->Texture());
    EXPECT_EQ(BoundColorTextureName(framebuffer, 0), first->Texture()->TextureID());

    framebuffer.SetAttachment(0, 0, second);
    EXPECT_EQ(framebuffer.GetColorAttachmentTexture(0, 0), second->Texture());
    EXPECT_EQ(framebuffer.GetAttachment(0, TextureAttachment::AttachmentType::Color, 0), second);
    EXPECT_EQ(BoundColorTextureName(framebuffer, 0), second->Texture()->TextureID());
}

TEST_F(FramebufferTest, SetSizeReallocatesOwnedAttachments)
{
    Framebuffer framebuffer;
    ASSERT_TRUE(framebuffer.SetSize(32, 32));
    framebuffer.CreateColorAttachment(0, 0);

    auto owned = MakeColorAttachment(32, 32);
    framebuffer.SetAttachment(0, 1, owned);

    ASSERT_TRUE(framebuffer.SetSize(64, 48));

    for (int index = 0; index < 2; index++)
    {
        const auto texture = framebuffer.GetColorAttachmentTexture(0, index);
        ASSERT_NE(texture, nullptr);
        EXPECT_EQ(texture->Width(), 64) << "attachment " << index;
        EXPECT_EQ(texture->Height(), 48) << "attachment " << index;
        EXPECT_EQ(BoundColorTextureName(framebuffer, index), texture->TextureID()) << "attachment " << index;
    }
    // Owned attachments are resized in place: the caller's TextureAttachment follows.
    EXPECT_EQ(owned->Texture()->Width(), 64);
}

TEST_F(FramebufferTest, SetSizeLeavesExternalAttachmentsUntouched)
{
    Framebuffer framebuffer;
    ASSERT_TRUE(framebuffer.SetSize(32, 32));
    framebuffer.CreateColorAttachment(0, 0);

    auto external = MakeColorAttachment(16, 16);
    const auto externalTexture = external->Texture();
    const GLuint externalName = externalTexture->TextureID();
    framebuffer.SetAttachment(0, 1, external, AttachmentStorage::External);

    ASSERT_TRUE(framebuffer.SetSize(64, 64));

    // Owned slot 0 still follows the framebuffer size.
    EXPECT_EQ(framebuffer.GetColorAttachmentTexture(0, 0)->Width(), 64);

    // External slot 1 is exactly what the caller attached, in both the map and GL.
    EXPECT_EQ(external->Texture(), externalTexture);
    EXPECT_EQ(externalTexture->TextureID(), externalName);
    EXPECT_EQ(externalTexture->Width(), 16);
    EXPECT_EQ(externalTexture->Height(), 16);
    EXPECT_EQ(framebuffer.GetColorAttachmentTexture(0, 1), externalTexture);
    EXPECT_EQ(BoundColorTextureName(framebuffer, 1), externalName);
}

TEST_F(FramebufferTest, ReattachingAsOwnedClearsExternalFlag)
{
    Framebuffer framebuffer;
    ASSERT_TRUE(framebuffer.SetSize(32, 32));

    auto attachment = MakeColorAttachment(32, 32);
    framebuffer.SetAttachment(0, 0, attachment, AttachmentStorage::External);
    framebuffer.SetAttachment(0, 0, attachment);

    ASSERT_TRUE(framebuffer.SetSize(64, 64));
    EXPECT_EQ(attachment->Texture()->Width(), 64);
    EXPECT_EQ(BoundColorTextureName(framebuffer, 0), attachment->Texture()->TextureID());
}

TEST_F(FramebufferTest, RemovingAnExternalSlotClearsExternalFlag)
{
    Framebuffer framebuffer;
    ASSERT_TRUE(framebuffer.SetSize(32, 32));

    auto external = MakeColorAttachment(32, 32);
    framebuffer.SetAttachment(0, 0, external, AttachmentStorage::External);
    framebuffer.RemoveColorAttachment(0, 0);
    framebuffer.CreateColorAttachment(0, 0);

    ASSERT_TRUE(framebuffer.SetSize(64, 64));
    const auto texture = framebuffer.GetColorAttachmentTexture(0, 0);
    ASSERT_NE(texture, nullptr);
    EXPECT_EQ(texture->Width(), 64);
    EXPECT_EQ(BoundColorTextureName(framebuffer, 0), texture->TextureID());
    // The removed external texture was not resized behind the caller's back.
    EXPECT_EQ(external->Texture()->Width(), 32);
}
