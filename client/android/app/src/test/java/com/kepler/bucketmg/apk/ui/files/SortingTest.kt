package com.kepler.bucketmg.apk.ui.files

import com.kepler.bucketmg.apk.data.model.FsEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 目录排序：文件夹恒在前，文件按当前模式排序。 */
class SortingTest {

    private fun file(name: String, size: Long = 0, mtime: String = "", folder: Boolean = false) =
        FsEntry(
            key = if (folder) "prefix/$name/" else "prefix/$name",
            name = name,
            size = size,
            lastModified = mtime,
            isFolder = folder,
            type = if (folder) "folder" else "file",
            encrypted = false,
        )

    @Test
    fun `空列表返回空列表`() {
        assertTrue(sortEntries(emptyList(), SortMode.NAME).isEmpty())
    }

    @Test
    fun `文件夹始终排在文件之前`() {
        val list = listOf(file("a.txt"), file("z-folder", folder = true), file("b.txt"))
        val sorted = sortEntries(list, SortMode.NAME)
        assertEquals(listOf("z-folder", "a.txt", "b.txt"), sorted.map { it.name })
    }

    @Test
    fun `名称排序忽略大小写且升序`() {
        val list = listOf(file("Charlie"), file("alpha"), file("Bravo"))
        assertEquals(
            listOf("alpha", "Bravo", "Charlie"),
            sortEntries(list, SortMode.NAME).map { it.name },
        )
    }

    @Test
    fun `大小排序为降序`() {
        val list = listOf(file("s", size = 10), file("l", size = 900), file("m", size = 100))
        assertEquals(
            listOf("l", "m", "s"),
            sortEntries(list, SortMode.SIZE).map { it.name },
        )
    }

    @Test
    fun `修改时间排序为降序`() {
        val list = listOf(
            file("old", mtime = "2026-01-01T00:00:00Z"),
            file("new", mtime = "2026-11-03T07:00:00Z"),
            file("mid", mtime = "2026-06-15T12:00:00Z"),
        )
        assertEquals(
            listOf("new", "mid", "old"),
            sortEntries(list, SortMode.TIME).map { it.name },
        )
    }

    @Test
    fun `切换排序模式不影响文件夹位置`() {
        val list = listOf(
            file("b-folder", size = 1, folder = true),
            file("a-folder", size = 5, folder = true),
            file("big", size = 900),
            file("small", size = 10),
        )
        val bySize = sortEntries(list, SortMode.SIZE)
        // 文件夹之间仍按名称升序，且全部在文件之前
        assertEquals(listOf("a-folder", "b-folder", "big", "small"), bySize.map { it.name })
        assertTrue(bySize.take(2).all { it.isFolder })
    }

    @Test
    fun `排序不修改原列表`() {
        val original = listOf(file("b"), file("a"))
        sortEntries(original, SortMode.NAME)
        assertEquals(listOf("b", "a"), original.map { it.name })
    }
}
